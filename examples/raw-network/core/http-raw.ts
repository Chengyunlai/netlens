/**
 * 第四层：HTTP/1.1 —— 自己拼报文、自己从字节流里切消息。
 *
 * 不使用 node:http，因为它替你做了三件最值得学的事：
 *   1. 拼请求报文（请求行、头字段、空行）
 *   2. 从字节流里切出响应头 —— TCP 是流，没有消息边界，
 *      第一次收到数据时可能只有半个头，也可能头和整个响应体一起来
 *   3. 判断响应体什么时候结束 —— Content-Length / chunked / 连接关闭，三种规则
 *
 * 这三件事在任何语言的 HTTP 客户端里都要处理一遍，只是通常被藏起来了。
 */

import type net from 'node:net';
import type tls from 'node:tls';

export interface RawHttpExchange {
  requestText: string;
  statusLine: string;
  statusCode: number;
  reason: string;
  headers: Array<[string, string]>;
  /** 每次 data 回调收到的字节数。用来观察 TCP 的"流"特性。 */
  reads: number[];
  bodyBytes: number;
  bodyPreview: string;
  /** 实际使用的结束规则。 */
  endRule: string;
  timings: {
    requestSent: number;
    firstByte: number;
    headComplete: number;
    end: number;
  };
}

export interface SpeakOptions {
  host: string;
  path?: string;
  method?: string;
  timeoutMs?: number;
}

export const findHeader = (
  headers: Array<[string, string]>,
  name: string,
): string | null => {
  const found = headers.find(([key]) => key.toLowerCase() === name);
  return found ? found[1] : null;
};

/**
 * 严格解析响应头。
 *
 * 每行都是 `字段名: 值`，冒号后允许空格。真实世界里还有以空格开头的折行，
 * HTTP/1.1 已废弃这种写法，这里遇到直接报错而不是静默吞掉。
 */
function parseHead(raw: string): {
  statusLine: string;
  statusCode: number;
  reason: string;
  headers: Array<[string, string]>;
} {
  const lines = raw.split('\r\n');
  const statusLine = lines[0] ?? '';
  const match = /^HTTP\/(\d\.\d) (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!match) throw new Error(`响应状态行无法解析：${JSON.stringify(statusLine)}`);

  // 正则已经保证了分组存在，但类型系统不知道；缺了就当报文非法，不要拿 NaN 当状态码。
  const statusCode = match[2];
  if (statusCode === undefined) {
    throw new Error(`响应状态行里没有状态码：${JSON.stringify(statusLine)}`);
  }

  const headers: Array<[string, string]> = [];
  for (const line of lines.slice(1)) {
    if (line.length === 0) continue;
    if (line.startsWith(' ') || line.startsWith('\t')) {
      throw new Error(`收到已废弃的响应头折行：${JSON.stringify(line)}`);
    }
    const separator = line.indexOf(':');
    if (separator < 0) throw new Error(`响应头格式非法：${JSON.stringify(line)}`);
    headers.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
  }

  return {
    statusLine,
    statusCode: Number.parseInt(statusCode, 10),
    reason: match[3] ?? '',
    headers,
  };
}

/**
 * 解析 chunked 编码。
 *
 * 每个分片是 `<十六进制长度>\r\n<内容>\r\n`，长度为 0 的分片表示结束。
 * 返回 complete=false 表示数据还没收全，需要继续等下一批字节 ——
 * 这正是流式解析的核心：解析器必须能被喂一半的数据。
 */
function decodeChunked(data: Buffer): { body: Buffer; complete: boolean; chunks: number } {
  const parts: Buffer[] = [];
  let cursor = 0;
  let chunks = 0;

  for (;;) {
    const lineEnd = data.indexOf('\r\n', cursor);
    if (lineEnd < 0) return { body: Buffer.concat(parts), complete: false, chunks };

    const sizeLine = data.toString('ascii', cursor, lineEnd);
    const size = Number.parseInt(sizeLine.split(';')[0] ?? '', 16);
    if (Number.isNaN(size)) return { body: Buffer.concat(parts), complete: false, chunks };
    if (size === 0) return { body: Buffer.concat(parts), complete: true, chunks };

    const chunkEnd = lineEnd + 2 + size;
    if (data.length < chunkEnd + 2) return { body: Buffer.concat(parts), complete: false, chunks };

    parts.push(data.subarray(lineEnd + 2, chunkEnd));
    chunks += 1;
    cursor = chunkEnd + 2;
  }
}

/**
 * 在一条已建立的连接上说一次 HTTP/1.1。
 *
 * 明文和 TLS 走的是同一段代码 —— 对 HTTP 来说，TLS 只是把底下的字节流换掉了，
 * 报文格式一个字都不变。这个事实用类型就能表达：只要求"能写能读"。
 */
export function speakHttp(
  socket: net.Socket | tls.TLSSocket,
  options: SpeakOptions,
): Promise<RawHttpExchange> {
  const { host, path = '/', method = 'GET', timeoutMs = 15_000 } = options;

  // 手写请求报文：请求行、头字段、一个空行表示头结束。
  // 每行以 CRLF 结尾 —— 少一个 \r，服务端会一直等下去。
  const requestText = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${host}`,
    'User-Agent: netlens-raw/0.1',
    'Accept: text/html,application/xhtml+xml,*/*;q=0.8',
    // 明确拒绝压缩：压缩后的 body 是二进制，看不清报文长什么样。
    // 真实客户端必须声明它支持的编码，否则白白多传流量。
    'Accept-Encoding: identity',
    // 让"读到连接关闭"成为一种合法的结束条件。
    'Connection: close',
    '',
    '',
  ].join('\r\n');

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const reads: number[] = [];
    let buffer = Buffer.alloc(0);
    let headEnd = -1;
    let head: ReturnType<typeof parseHead> | null = null;
    let firstByteAt: number | null = null;
    let headCompleteAt: number | null = null;
    let endRule = '连接关闭（响应里没有长度信息）';
    let settled = false;
    let requestSentAt = 0;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };

    const timer = setTimeout(() => {
      socket.destroy();
      finish(() => reject(new Error(`HTTP 交换在 ${timeoutMs} ms 内没有完成`)));
    }, timeoutMs);

    const settle = (body: Buffer): void => {
      finish(() =>
        resolve({
          requestText,
          statusLine: head?.statusLine ?? '',
          statusCode: head?.statusCode ?? 0,
          reason: head?.reason ?? '',
          headers: head?.headers ?? [],
          reads,
          bodyBytes: body.length,
          bodyPreview: body.subarray(0, 200).toString('utf8').replace(/\s+/g, ' ').trim(),
          endRule,
          timings: {
            requestSent: requestSentAt,
            firstByte: firstByteAt == null ? 0 : firstByteAt - startedAt,
            headComplete: headCompleteAt == null ? 0 : headCompleteAt - startedAt,
            end: performance.now() - startedAt,
          },
        }),
      );
    };

    /** 尝试从当前缓冲区里切出一条完整响应；数据不够就直接返回，等下一批。 */
    const ingest = (): void => {
      if (head === null) {
        const separator = buffer.indexOf('\r\n\r\n');
        // 没找到头结束符，说明头还没收全。已到的字节必须留着 ——
        // 这就是"半包"：一次 read 拿到的可能只是消息的一部分。
        if (separator < 0) return;

        headEnd = separator + 4;
        headCompleteAt = performance.now();
        head = parseHead(buffer.subarray(0, separator).toString('latin1'));

        const transferEncoding = findHeader(head.headers, 'transfer-encoding');
        const contentLength = findHeader(head.headers, 'content-length');
        if (transferEncoding?.toLowerCase().includes('chunked')) {
          endRule = 'Transfer-Encoding: chunked';
        } else if (contentLength !== null) {
          endRule = `Content-Length: ${contentLength}`;
        }
      }

      const bodyRaw = buffer.subarray(headEnd);

      if (endRule.startsWith('Content-Length:')) {
        const expected = Number.parseInt(endRule.slice('Content-Length: '.length), 10);
        if (bodyRaw.length >= expected) settle(bodyRaw.subarray(0, expected));
        return;
      }

      if (endRule === 'Transfer-Encoding: chunked') {
        const { body, complete } = decodeChunked(bodyRaw);
        if (complete) settle(body);
      }
    };

    socket.on('data', (chunk) => {
      reads.push(chunk.length);
      if (firstByteAt === null) firstByteAt = performance.now();
      buffer = Buffer.concat([buffer, chunk]);
      ingest();
    });

    socket.on('end', () => {
      // 对端关闭连接。要么本来就没有长度信息（这就是结束条件），
      // 要么是提前断开 —— 后者不能假装成功。
      if (head === null) {
        finish(() => reject(new Error('连接在响应头收全之前就被关闭了')));
        return;
      }

      const bodyRaw = buffer.subarray(headEnd);
      if (endRule.startsWith('Content-Length:')) {
        const expected = Number.parseInt(endRule.slice('Content-Length: '.length), 10);
        if (bodyRaw.length < expected) {
          finish(() =>
            reject(
              new Error(`响应不完整：声明 ${expected} 字节，实际只收到 ${bodyRaw.length} 字节`),
            ),
          );
          return;
        }
      }
      settle(bodyRaw);
    });

    socket.on('error', (error) => {
      finish(() => reject(error));
    });

    requestSentAt = performance.now() - startedAt;
    socket.write(requestText);
  });
}
