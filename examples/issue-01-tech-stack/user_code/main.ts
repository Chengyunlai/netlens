/**
 * 最短路径：导入公开 API，对一个真实站点探测一次，打印结果。
 *
 * 运行：
 *   node examples/issue-01-tech-stack/user_code/main.ts
 *
 * 注意这条命令前后没有任何 install / build——这正是 issue #1 要验证的承诺。
 */
import { probe } from '../../../src/probe.ts';

const target = process.argv[2] ?? 'https://example.com';
const result = await probe(target);

console.log(`\n${result.url}`);
console.log(`  状态码    ${result.statusCode ?? '—'}`);
console.log(
  `  远端      ${result.remote ? `${result.remote.address}:${result.remote.port} (${result.remote.family})` : '—'}`,
);
console.log(`  请求协议  ${result.alpn ?? '—'}`);
console.log(`  TLS       ${result.tlsProtocol ?? '—'}`);
console.log(`  响应体    ${result.bytes ?? '—'} 字节`);

console.log('\n各阶段时间戳（相对请求起点的毫秒偏移）');
for (const stage of ['dns', 'tcp', 'tls', 'firstByte', 'end'] as const) {
  const at = result.phases[stage];
  console.log(`  ${stage.padEnd(10)} ${at == null ? '—' : `${at.toFixed(1)} ms`}`);
}
console.log('');
