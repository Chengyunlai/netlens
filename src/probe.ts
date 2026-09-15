import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import type { TLSSocket } from 'node:tls';

import type { FailureLayer, Phases, ProbeResult } from './types.ts';

/** 请求起点。所有阶段时间戳都是相对它的偏移。 */
const now = (): number => performance.now();

/** 探测失败时抛出：带上失败层级和已经走完的阶段，便于定位断在哪一段。 */
export class ProbeError extends Error {
  readonly layer: FailureLayer;
  readonly phases: Phases;

  constructor(message: string, layer: FailureLayer, phases: Phases) {
    super(message);
    this.name = 'ProbeError';
    this.layer = layer;
    this.phases = phases;
  }
}

/**
 * 根据时间线推进到哪里断掉来判断失败层级。
 *
 * 不依赖错误码的完备列表——错误码在各平台差异很大——
 * 而是看"走到哪一步为止还留下了时间戳"。
 */
function inferLayer(phases: Phases, code: string | undefined): FailureLayer {
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (phases.tcp == null) return 'tcp';
  if (phases.firstByte == null) return 'tls';
  return 'http';
}

/**
 * Node 的 http 模块只懂 HTTP/1.1 的报文格式，不会处理 HTTP/2 帧。
 * 所以这里固定只声明 http/1.1：如果声明 h2 并且真的协商成功，
 * 请求反而会因为格式不符而失败。
 *
 * 想知道"服务端到底支持哪些协议"，需要一次独立的协商握手，
 * 那属于后续 issue（协议探测）。
 */
const createAgent = (scheme: 'http' | 'https'): http.Agent | https.Agent =>
  scheme === 'https'
    ? new https.Agent({ ALPNProtocols: ['http/1.1'], keepAlive: false })
    : new http.Agent({ keepAlive: false });

/**
 * 单次探测的时长上限。
 *
 * 目标端口若只是丢弃 SYN（而不是回一个 RST），内核会重试很久，
 * 没有这层保护时命令会一直挂住、什么都不输出——那是最难排查的一类"卡住"。
 */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ProbeOptions {
  /** 单次探测的时长上限，默认 {@link DEFAULT_TIMEOUT_MS} */
  timeoutMs?: number;
}

/**
 * 对一个 URL 发一次真实请求，记录各协议阶段的时间戳。
 *
 * 时间点全部来自 socket 的真实事件，而不是从总耗时里反推。
 * 连接被复用时 lookup / connect / secureConnect 都不会触发，
 * 因此那些字段为空不是 bug——它本身就是"连接被复用"的证据。
 */
export function probe(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const scheme = parsed.protocol === 'https:' ? 'https' : 'http';
    const client = scheme === 'https' ? https : http;
    const startedAt = now();
    const phases: Phases = {};
    const result: ProbeResult = { url, scheme, phases };

    const request = client.request(url, {
      method: 'GET',
      agent: createAgent(scheme),
      headers: {
        'user-agent': 'netlens/0.1.0',
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-encoding': 'gzip, deflate, br',
      },
    });

    // 这里用的是独立定时器，而不是 request.setTimeout()。
    // 后者的语义是"socket 空闲超时"，且**只在 socket 已连接之后才生效**——
    // 而最需要保护的恰恰是"连都连不上"的那段时间（SYN 被丢弃时，
    // 内核会重试到 75 秒左右才放弃）。
    const timer = setTimeout(() => {
      const timeout: NodeJS.ErrnoException = new Error(`探测在 ${timeoutMs} ms 内没有完成`);
      timeout.code = 'ETIMEDOUT';
      request.destroy(timeout);
    }, timeoutMs);

    request.on('socket', (socket) => {
      socket.once('lookup', () => {
        phases.dns = now() - startedAt;
      });

      // 远端地址只能在 connect 之后读：lookup 触发时连接尚未建立，
      // remoteAddress / remotePort 都还是 undefined，读出来是 0。
      socket.once('connect', () => {
        phases.tcp = now() - startedAt;
        result.remote = {
          address: socket.remoteAddress ?? '未知',
          port: socket.remotePort ?? 0,
          family: socket.remoteFamily ?? 'IPv4',
        };
      });

      socket.once('secureConnect', () => {
        phases.tls = now() - startedAt;
        const secure = socket as TLSSocket;
        result.tlsProtocol = secure.getProtocol();
        result.alpn = secure.alpnProtocol || null;
      });
    });

    request.on('response', (response) => {
      phases.firstByte = now() - startedAt;
      result.statusCode = response.statusCode;

      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      response.on('end', () => {
        phases.end = now() - startedAt;
        result.bytes = bytes;
        clearTimeout(timer);
        resolve(result);
      });
    });

    request.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new ProbeError(error.message, inferLayer(phases, error.code), { ...phases }));
    });

    request.end();
  });
}
