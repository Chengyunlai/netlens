/**
 * 第一层：DNS —— 自己拼查询报文。
 *
 * 为什么不直接用 node:dns：
 *   `lookup()` 把查询交给操作系统解析器（会先读 hosts，再由系统的解析服务处理），
 *   `resolve*()` 交给随 Node 编译进来的 c-ares。
 *   两条路都把 DNS 报文本身藏起来了。
 *
 * 这里手动构造查询、手动拆响应，为的是看清 DNS 的原始形态：
 * 一个 UDP 数据报出去、一个回来 —— 没有握手，没有重传，没有"连接"这个东西。
 */

import dgram from 'node:dgram';
import { readFile } from 'node:fs/promises';

/** 只用得到这几种记录类型。 */
export const RecordType = {
  A: 1,
  CNAME: 5,
  AAAA: 28,
} as const;

const TYPE_NAME: Record<number, string> = {
  1: 'A',
  2: 'NS',
  5: 'CNAME',
  6: 'SOA',
  15: 'MX',
  16: 'TXT',
  28: 'AAAA',
  46: 'RRSIG',
};

const RCODE_NAME: Record<number, string> = {
  0: 'NOERROR',
  1: 'FORMERR',
  2: 'SERVFAIL',
  3: 'NXDOMAIN',
  4: 'NOTIMP',
  5: 'REFUSED',
};

const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value, 0);
  return buffer;
};

/**
 * 域名编成问题段格式：每个标签前面一个长度字节，末尾一个 0 字节表示根。
 * 长度上限 63 是协议规定的（长度字节的高两位被 0xC0 指针占用了）。
 */
export function encodeName(hostname: string): Buffer {
  const labels = hostname.replace(/\.$/, '').split('.');
  const parts: Buffer[] = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, 'ascii');
    if (bytes.length === 0 || bytes.length > 63) {
      throw new Error(`DNS 标签长度非法（${bytes.length} 字节）：${label}`);
    }
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.alloc(1));
  return Buffer.concat(parts);
}

/**
 * 读一个域名。
 *
 * 响应里几乎不会重复写完整域名，而是用 0xC0 开头的两字节指针指回报文前面
 * 出现过的位置 —— 这就是"名字压缩"，省掉大量重复字节。
 * 指针可以指向另一个指针，所以必须防成环，否则损坏的报文会让解析器卡死。
 */
export function readName(buffer: Buffer, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let cursor = start;
  let next = start;
  let jumped = false;
  let hops = 0;

  for (;;) {
    hops += 1;
    if (hops > 64) throw new Error('DNS 名字压缩指针成环，报文已损坏');

    const length = buffer[cursor];
    if (length === undefined) throw new Error('DNS 报文在名字中间结束');

    if (length === 0) {
      cursor += 1;
      if (!jumped) next = cursor;
      break;
    }

    if ((length & 0xc0) === 0xc0) {
      // 指针占两个字节。报文若正好在这里被截断，第二个字节就是缺失的 ——
      // 那种情况下位运算会算出一个凭空的偏移量，然后一路读下去。
      // 与其静默给出错误域名，不如在这里停住。
      const low = buffer[cursor + 1];
      if (low === undefined) throw new Error('DNS 名字压缩指针只收到一个字节，报文被截断');

      const target = ((length & 0x3f) << 8) | low;
      if (!jumped) next = cursor + 2;
      jumped = true;
      cursor = target;
      continue;
    }

    labels.push(buffer.toString('ascii', cursor + 1, cursor + 1 + length));
    cursor += 1 + length;
  }

  return { name: labels.join('.'), next };
}

export interface DnsRecord {
  name: string;
  type: number;
  typeName: string;
  ttl: number;
  value: string;
}

export interface DnsResponse {
  id: number;
  rcode: number;
  rcodeName: string;
  authoritative: boolean;
  /** TC 位置 1 表示响应超过 512 字节被截断，此时标准做法是改用 TCP 重查。 */
  truncated: boolean;
  recursionAvailable: boolean;
  questionCount: number;
  answerCount: number;
  records: DnsRecord[];
}

/** 构造一次标准查询。RD=1 表示要求服务器替我们递归查到底。 */
export function buildQuery(hostname: string, type: number = RecordType.A, id = 0x1234): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, encodeName(hostname), u16(type), u16(1)]);
}

/**
 * 解析响应报文。
 *
 * 只解释本实验关心的记录类型，其余照样列出来但不深究 ——
 * 真实响应里常常混着 SOA、RRSIG、DNSKEY，硬要全解析是另一件事。
 */
export function parseResponse(buffer: Buffer, expectedId: number): DnsResponse {
  if (buffer.length < 12) throw new Error('DNS 响应不足 12 字节，报文头都不完整');

  const id = buffer.readUInt16BE(0);
  if (id !== expectedId) {
    // UDP 上没有连接，收到不属于本次查询的数据报是可能的，必须靠 ID 认领。
    throw new Error(`DNS 响应 ID 不匹配（期望 ${expectedId}，收到 ${id}）`);
  }

  const flags = buffer.readUInt16BE(2);
  const questionCount = buffer.readUInt16BE(4);
  const answerCount = buffer.readUInt16BE(6);

  let cursor = 12;
  for (let index = 0; index < questionCount; index += 1) {
    cursor = readName(buffer, cursor).next + 4; // QTYPE + QCLASS
  }

  const records: DnsRecord[] = [];
  for (let index = 0; index < answerCount; index += 1) {
    const { name, next } = readName(buffer, cursor);
    const type = buffer.readUInt16BE(next);
    const ttl = buffer.readUInt32BE(next + 4);
    const dataLength = buffer.readUInt16BE(next + 8);
    const dataStart = next + 10;

    let value: string;
    switch (type) {
      case RecordType.A:
        value = [...buffer.subarray(dataStart, dataStart + 4)].join('.');
        break;
      case RecordType.AAAA:
        value = buffer
          .subarray(dataStart, dataStart + 16)
          .toString('hex')
          .replace(/(....)/g, '$1:')
          .replace(/:$/, '');
        break;
      case RecordType.CNAME:
      case 2:
      case 6:
      case 15:
        // 这几类的 RDATA 本身又是一个域名，同样可能被压缩。
        value = readName(buffer, dataStart).name;
        break;
      default:
        value = `${dataLength} 字节`;
    }

    records.push({ name, type, typeName: TYPE_NAME[type] ?? `TYPE${type}`, ttl, value });
    cursor = dataStart + dataLength;
  }

  const rcode = flags & 0x000f;
  return {
    id,
    rcode,
    rcodeName: RCODE_NAME[rcode] ?? `RCODE${rcode}`,
    authoritative: (flags & 0x0400) !== 0,
    truncated: (flags & 0x0200) !== 0,
    recursionAvailable: (flags & 0x0080) !== 0,
    questionCount,
    answerCount,
    records,
  };
}

/**
 * 本机的 DNS 服务器。
 *
 * 注意一个 macOS 特有的坑：这个文件开头就写着"本文件不参与域名解析"，
 * 系统真正用的是 mDNSResponder。它之所以还有内容，是系统顺手写的一份快照。
 * 用它做实验没问题，但要清楚它不等于系统实际使用的配置（`scutil --dns` 才是）。
 */
export async function readResolvers(path = '/etc/resolv.conf'): Promise<string[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('nameserver'))
    .map((line) => line.split(/\s+/)[1] ?? '')
    .filter((address) => address.length > 0);
}

export interface DnsExchange {
  server: string;
  queryBytes: number;
  responseBytes: number;
  rttMs: number;
  response: DnsResponse;
}

/**
 * 发一次 UDP 查询。
 *
 * 这里不实现重传：UDP 不保证送达，超时该由谁来兜底是个设计决定，
 * 交给调用方（换服务器还是重试）比藏在底层更诚实。
 */
export function ask(
  server: string,
  query: Buffer,
  expectedId: number,
  timeoutMs: number,
): Promise<DnsExchange> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const startedAt = performance.now();
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      action();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`${server} 在 ${timeoutMs} ms 内没有回应（UDP 不重传，兜底是应用层的事）`)),
      );
    }, timeoutMs);

    socket.on('error', (error) => finish(() => reject(error)));
    socket.on('message', (response) => {
      finish(() => {
        try {
          resolve({
            server,
            queryBytes: query.length,
            responseBytes: response.length,
            rttMs: performance.now() - startedAt,
            response: parseResponse(response, expectedId),
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    socket.send(query, 53, server, (error) => {
      if (error) finish(() => reject(error));
    });
  });
}

export interface Resolution {
  hostname: string;
  exchange: DnsExchange;
  /** 可直接用于连接的地址。CNAME 只是别名，不能连。 */
  addresses: string[];
  /** 解析过程中经过的别名链。 */
  cnameChain: string[];
}

export interface ResolveOptions {
  servers?: string[];
  type?: number;
  timeoutMs?: number;
  resolvConfPath?: string;
}

/**
 * 完整解析一个域名：按顺序试本机配置的 DNS 服务器，第一个成功的就采用。
 *
 * 服务器之间是"依次尝试"而不是"并发广播" —— 真实解析器两种都做，
 * 但依次尝试更容易看清每一步。
 */
export async function resolve(
  hostname: string,
  options: ResolveOptions = {},
): Promise<Resolution> {
  const servers = options.servers ?? (await readResolvers(options.resolvConfPath));
  if (servers.length === 0) throw new Error('没有可用的 DNS 服务器');

  const type = options.type ?? RecordType.A;
  const timeoutMs = options.timeoutMs ?? 3000;
  const id = 0x1000 + Math.floor(Math.random() * 0x0fff);
  const query = buildQuery(hostname, type, id);

  let lastError: unknown = null;
  for (const server of servers) {
    try {
      const exchange = await ask(server, query, id, timeoutMs);

      if (exchange.response.truncated) {
        // 超过 512 字节的响应在 UDP 上会被截断，标准做法是改用 TCP 端口 53 重查。
        // 这里只报出来，不实现 TCP 回退 —— 那是独立的一件事。
        console.warn(`  ! 响应被截断（TC=1），标准做法是改用 TCP 重查`);
      }
      if (exchange.response.rcode !== 0) {
        throw new Error(`${hostname} 解析失败：${exchange.response.rcodeName}`);
      }

      const addresses = exchange.response.records
        .filter((record) => record.type === type)
        .map((record) => record.value);
      const cnameChain = exchange.response.records
        .filter((record) => record.type === RecordType.CNAME)
        .map((record) => record.value);

      if (addresses.length === 0) {
        throw new Error(`${hostname} 没有返回可用的地址记录`);
      }

      return { hostname, exchange, addresses, cnameChain };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
