#!/usr/bin/env node
/**
 * 入口：把四层串起来，每一步都打印出来。
 *
 * 四层之间只通过参数传递结果，没有共享状态，也没有一个"网络类"把什么都装进去。
 * 这样任何一层都能单独替换：想换成自己写的 HTTP 解析，只动第四层；
 * 想加 QUIC，也不用碰前三层。
 */

import process from 'node:process';
import { isIP } from 'node:net';

import { displayWidth, formatMs, padTo, Stopwatch } from '../core/util.ts';
import { RecordType, resolve } from '../core/dns.ts';
import { connectTcp } from '../core/tcp.ts';
import { handshake } from '../core/tls.ts';
import { findHeader, speakHttp } from '../core/http-raw.ts';

interface Options {
  url: string;
  path: string;
  insecure: boolean;
  tls12: boolean;
}

const USAGE = `
用法
  node main.ts <域名或 URL> [选项]

选项
  --path <路径>     请求路径，默认取 URL 里的
  --tls12           把 TLS 版本上限压到 1.2，用来看握手多出的那一个往返
  --insecure        不校验证书（只为观察自签名网站）

示例
  node main.ts example.com
  node main.ts http://example.com --path /index.html
  node main.ts example.com --tls12
`.trim();

function parseArgs(argv: string[]): Options | null {
  const positional: string[] = [];
  const flags = new Set<string>();
  let explicitPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // 索引访问在类型上可能是 undefined，先挡掉再判断，避免缺值时抛裸异常。
    if (arg === undefined) continue;

    if (arg === '--path') {
      explicitPath = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith('--')) {
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }

  const target = positional[0];
  if (!target) return null;

  const url = new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`);
  return {
    url: url.toString(),
    path: explicitPath ?? (url.pathname + url.search || '/'),
    insecure: flags.has('--insecure'),
    tls12: flags.has('--tls12'),
  };
}

const LABEL_WIDTH = 10;

/** 一行"字段 值 注释"。中文字符占两列，所以补齐要看显示宽度。 */
const line = (label: string, value: string, note = ''): string =>
  `    ${padTo(label, LABEL_WIDTH)}  ${value}${note ? `   ${note}` : ''}`;

const rule = (index: string, title: string): string => `\n[${index}] ${title}`;

/**
 * 在指定的一层里执行一段逻辑。
 *
 * 失败时不是抛一个笼统错误，而是明确说出"哪一层坏了"：
 * DNS 挂了和 TLS 挂了，排查方向完全不同。
 */
async function stage<T>(
  layer: string,
  out: string[],
  action: () => Promise<T>,
): Promise<T | null> {
  try {
    return await action();
  } catch (error) {
    out.push('', `    ${layer} 阶段失败：${(error as Error).message}`, '');
    console.log(out.join('\n'));
    process.exitCode = 1;
    return null;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.log(USAGE);
    process.exit(1);
  }

  const target = new URL(options.url);
  const secure = target.protocol === 'https:';
  const port = target.port ? Number(target.port) : secure ? 443 : 80;
  const hostname = target.hostname;
  const watch = new Stopwatch();

  const out: string[] = ['', 'netlens 原始版 — 把一个请求逐层拆开', ''];
  out.push(`目标  ${options.url}`);

  // 第 1 层：DNS
  out.push(rule('1', 'DNS · 自己拼查询报文，UDP 直连'));
  let addresses: string[] = [];
  let dnsRttMs = 0;

  if (isIP(hostname) !== 0) {
    // 已经是 IP 就没有可解析的东西。真实客户端也必须做这个判断 ——
    // 把 IP 字面量当域名丢给解析器，多数实现会返回一个语焉不详的失败。
    out.push(line('跳过', `${hostname} 是 IP 字面量`, '无需解析'));
    addresses = [hostname];
  } else {
    const resolution = await stage('DNS', out, () => resolve(hostname, { type: RecordType.A }));
    if (resolution === null) return;

    const dns = resolution.exchange;
    dnsRttMs = dns.rttMs;
    out.push(line('服务器', dns.server, '取自 /etc/resolv.conf'));
    out.push(line('报文', `查询 ${dns.queryBytes} 字节 → 响应 ${dns.responseBytes} 字节`));
    out.push(line('往返', formatMs(dns.rttMs), '一次数据报来回，没有握手、没有重传'));
    out.push(line('应答', `${dns.response.records.length} 条`));
    // 域名长度差异很大（CNAME 链能拉得很长），列宽按实际内容算，不然会冲歪。
    const nameWidth = Math.max(
      24,
      ...dns.response.records.map((record) => displayWidth(record.name)),
    );
    for (const record of dns.response.records) {
      out.push(
        `      ${padTo(record.name, nameWidth)} ${padTo(record.typeName, 6)} TTL ${padTo(String(record.ttl), 6)} ${record.value}`,
      );
    }
    if (resolution.cnameChain.length > 0) {
      out.push(line('别名链', resolution.cnameChain.join(' → ')));
    }
    addresses = resolution.addresses;
  }

  // 第 2 层：TCP
  out.push(rule('2', 'TCP · 三次握手'));
  // 解析可能返回多个地址，逐个尝试 —— 这就是客户端侧的故障转移。
  const connection = await stage('TCP', out, async () => {
    for (const address of addresses) {
      try {
        return await connectTcp(address, port);
      } catch (error) {
        out.push(line('建连失败', `${address} — ${(error as Error).message}`, '换下一个地址'));
      }
    }
    throw new Error(`解析到的 ${addresses.length} 个地址都连不上`);
  });
  if (connection === null) return;

  out.push(line('连接', `${connection.remote.address}:${connection.remote.port} (${connection.remote.family})`));
  out.push(line('本地', `${connection.local.address}:${connection.local.port}`, `内核里的 fd ${connection.fd}`));
  out.push(line('握手', formatMs(connection.connectMs), '≈ 1 个 RTT，是所有网络延迟的基数'));

  // 第 3 层：TLS
  let socket = connection.socket;
  let tlsMs = 0;
  if (secure) {
    out.push(rule('3', 'TLS · 握手与协商'));
    const secured = await stage('TLS', out, () =>
      handshake(socket, {
        servername: hostname,
        maxVersion: options.tls12 ? 'TLSv1.2' : undefined,
        rejectUnauthorized: !options.insecure,
      }),
    );
    if (secured === null) return;

    socket = secured.socket;
    tlsMs = secured.handshakeMs;

    const info = secured.info;
    out.push(line('耗时', formatMs(tlsMs), options.tls12 ? '上限压到 TLS 1.2' : ''));
    out.push(line('版本', info.protocol ?? '未知'));
    out.push(line('套件', info.cipher ?? '未知', '握手选定的对称加密算法'));
    out.push(line('ALPN', info.alpn ?? '（未协商）', '决定这条连接上跑 HTTP/1.1 还是 HTTP/2'));
    out.push(line('SNI', info.servername ?? '（未发送）', '明文阶段告诉服务端要访问哪个域名'));
    out.push(
      line(
        '证书',
        info.authorized ? '已验证' : '未通过',
        info.authorizationError ?? '',
      ),
    );
    out.push(line('证书链', `${info.chain.length} 级`));
    for (const entry of info.chain) {
      out.push(`      ${entry.subject}`);
      out.push(`          签发 ${entry.issuer}`);
      out.push(`          有效 ${entry.validFrom} → ${entry.validTo}`);
    }
  } else {
    out.push(rule('3', 'TLS · 跳过（明文连接）'));
  }

  // 第 4 层：HTTP
  out.push(rule('4', 'HTTP/1.1 · 手写请求报文'));
  const httpStart = watch.at();
  const exchange = await stage('HTTP', out, () =>
    speakHttp(socket, { host: hostname, path: options.path }),
  );
  if (exchange === null) return;

  out.push(line('请求', `${exchange.requestText.split('\r\n')[0]}`));
  out.push(line('状态', `${exchange.statusCode} ${exchange.reason}`.trim()));
  out.push(line('服务端', findHeader(exchange.headers, 'server') ?? '—'));
  out.push(line('读取', `${exchange.reads.length} 次`, exchange.reads.join(' / ') + ' 字节'));
  out.push(line('结束规则', exchange.endRule, '三种规则之一：定长 / 分片 / 连接关闭'));
  out.push(line('响应体', `${exchange.bodyBytes} 字节`));
  out.push(line('首字节', formatMs(httpStart + exchange.timings.firstByte), '相对整次探测的起点'));
  if (exchange.bodyPreview) {
    out.push(line('正文开头', exchange.bodyPreview.slice(0, 90)));
  }

  const setupTax = dnsRttMs + connection.connectMs + tlsMs;
  out.push('');
  out.push('    ' + '─'.repeat(52));
  out.push(
    line(
      '建连过路费',
      formatMs(setupTax),
      `DNS ${formatMs(dnsRttMs)} + TCP ${formatMs(connection.connectMs)}${secure ? ` + TLS ${formatMs(tlsMs)}` : ''}`,
    ),
  );
  out.push(line('总耗时', formatMs(watch.at()), '从进程开始到读完响应体'));
  out.push('');

  console.log(out.join('\n'));
}

await main();
