/**
 * 第二层：TCP —— 三次握手，以及握手之后你拿到了什么。
 *
 * 建连本身被 Node 封装成了一次 `connect` 事件，但有三件事在这里是可见的：
 *   · 文件描述符：每一条连接在内核里就是一个 fd，用完必须还回去
 *   · 本地端口：客户端这一侧的端口由内核分配，它决定"这条连接"的身份
 *   · 耗时：TCP 握手至少要一个 RTT，这是所有网络延迟的基数
 */

import net from 'node:net';

export interface TcpConnection {
  socket: net.Socket;
  connectMs: number;
  remote: { address: string; port: number; family: string };
  local: { address: string; port: number };
  /**
   * 内核里的文件描述符。
   *
   * 这是 Node 的内部字段（下划线开头），不属于公开 API，换个版本可能就变了。
   * 之所以还是读它：fd 是理解"连接是一种稀缺操作系统资源"最直接的入口 ——
   * 句柄耗尽（EMFILE）在生产环境里是真实故障。
   */
  fd: number | null;
}

export interface ConnectOptions {
  timeoutMs?: number;
  /** 是否关闭 Nagle 算法。默认关闭，见下面的说明。 */
  noDelay?: boolean;
}

export function connectTcp(
  host: string,
  port: number,
  options: ConnectOptions = {},
): Promise<TcpConnection> {
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const socket = net.createConnection({ host, port });

    // TCP_NODELAY：关掉 Nagle 算法。
    // Nagle 会把小包攒起来等确认，对吞吐友好，但对交互式请求是灾难 ——
    // 一个 100 字节的请求可能被硬生生攒到下一个 ACK 才发出去。
    // 库和运行时默认都开 noDelay，正是因为在这里"延迟"比"包数"重要。
    if (options.noDelay !== false) socket.setNoDelay(true);

    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `TCP 建连 ${timeoutMs} ms 未完成。目标若只丢弃 SYN 而不回 RST，内核会按指数退避重试很久。`,
        ),
      );
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve({
        socket,
        connectMs: performance.now() - startedAt,
        remote: {
          address: socket.remoteAddress ?? '未知',
          port: socket.remotePort ?? 0,
          family: socket.remoteFamily ?? '未知',
        },
        local: {
          address: socket.localAddress ?? '未知',
          port: socket.localPort ?? 0,
        },
        fd: (socket as unknown as { _handle?: { fd?: number } })._handle?.fd ?? null,
      });
    });

    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
