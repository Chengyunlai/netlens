#!/usr/bin/env node
/**
 * netlens 命令行入口。
 *
 * 本阶段（issue #1）只做一件事：证明"克隆后无需构建即可运行"这句承诺成立。
 * 输出的是原始分层耗时——诊断规则、冷热对比和彩色渲染都属于后续 issue。
 */
import process from 'node:process';

import { probe, ProbeError } from './probe.ts';
import type { Phases, ProbeResult } from './types.ts';

/** 开发期直接运行 .ts 依赖 Node 的类型剥离能力，22.18 起默认启用。 */
const MIN_NODE_MAJOR = 22;

const USAGE = `
netlens — 把网络层细节翻译成 Web 性能结论

用法
  netlens <url>

示例
  netlens https://example.com
`;

/**
 * 版本检查要在做任何别的事之前跑。
 * 否则在旧版 Node 上会遇到难以理解的语法错误，而不是一句人话。
 */
function assertRuntime(): void {
  const major = Number.parseInt(process.versions.node, 10);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    console.error(`netlens 需要 Node ${MIN_NODE_MAJOR} 或更高版本，当前为 ${process.versions.node}。`);
    console.error('开发期直接运行 .ts 依赖 Node 的类型剥离能力（22.18 起默认启用）。');
    process.exit(1);
  }
}

/** 中文字符在终端占两列，padEnd 按字符数算会对不齐，所以自己算显示宽度。 */
const displayWidth = (text: string): number =>
  [...text].reduce((width, char) => width + (/[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 2 : 1), 0);

const padTo = (text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - displayWidth(text)));

const formatMs = (value: number | undefined): string =>
  value == null ? '—' : `${value.toFixed(1)} ms`;

/**
 * 把时间戳拆成五段耗时——每段都是"上一个时间戳到这一个"的差。
 *
 * 首字节那一栏必须扣掉建连：不扣的话，"服务端慢"和"连接慢"会混成一个数字，
 * 而这两者的优化方向完全不同。
 */
function splitPhases(phases: Phases): Array<{ label: string; ms: number | undefined }> {
  const connectedAt = phases.tls ?? phases.tcp ?? phases.dns ?? 0;
  return [
    { label: 'DNS 解析', ms: phases.dns },
    { label: 'TCP 握手', ms: phases.tcp == null ? undefined : phases.tcp - (phases.dns ?? 0) },
    { label: 'TLS 握手', ms: phases.tls == null ? undefined : phases.tls - (phases.tcp ?? 0) },
    {
      label: '首字节',
      ms: phases.firstByte == null ? undefined : phases.firstByte - connectedAt,
    },
    {
      label: '响应传输',
      ms: phases.end == null || phases.firstByte == null ? undefined : phases.end - phases.firstByte,
    },
  ];
}

function render(result: ProbeResult): string {
  const stages = splitPhases(result.phases);
  const width = Math.max(...stages.map((stage) => displayWidth(stage.label)));
  const line = (label: string, value: string): string =>
    `  ${padTo(label, width)}  ${value}`;

  const lines = ['', result.url, '', '分层耗时（冷请求，首次连接）'];
  for (const stage of stages) {
    lines.push(line(stage.label, formatMs(stage.ms).padStart(9)));
  }
  lines.push(`  ${'─'.repeat(width + 11)}`);
  lines.push(line('合计', formatMs(result.phases.end).padStart(9)));

  lines.push('', '连接信息');
  lines.push(
    line(
      '远端',
      result.remote ? `${result.remote.address}:${result.remote.port} (${result.remote.family})` : '—',
    ),
  );
  lines.push(line('请求协议', result.alpn ?? '—'));
  lines.push(line('TLS', result.tlsProtocol ?? '—'));
  lines.push(line('状态码', String(result.statusCode ?? '—')));
  lines.push(line('响应体', result.bytes == null ? '—' : `${result.bytes} 字节`));
  lines.push('');

  return lines.join('\n');
}

async function main(): Promise<void> {
  assertRuntime();

  const target = process.argv[2];
  if (target == null || target === '-h' || target === '--help') {
    console.log(USAGE);
    process.exit(target == null ? 1 : 0);
  }

  let url: string;
  try {
    url = new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`).toString();
  } catch {
    console.error(`无法解析的 URL：${target}`);
    process.exit(1);
  }

  try {
    console.log(render(await probe(url)));
  } catch (error) {
    if (error instanceof ProbeError) {
      console.error(`\n请求在 ${error.layer.toUpperCase()} 阶段失败：${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

await main();
