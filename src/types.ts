/**
 * 类型定义。本文件不产生任何运行时代码。
 *
 * 它是"为什么这个项目选 TypeScript"最直接的证据：一次探测会产生哪些数据、
 * 每个字段在协议层意味着什么，全部写在一处，读代码的人不需要翻实现去找。
 */

/** 失败发生在协议的哪一层。用于把错误定位到具体阶段，而不是笼统报"请求失败"。 */
export type FailureLayer = 'dns' | 'tcp' | 'tls' | 'http';

/**
 * 各协议阶段完成时的**时间戳**（相对请求起点的毫秒偏移）。
 *
 * 存时间戳而不是耗时，是因为任意两段之间都可能需要求差；
 * 存耗时的话每换一种分析角度都要回头改数据结构。
 */
export interface Phases {
  /** DNS 解析完成 —— socket 的 lookup 事件 */
  dns?: number;
  /** TCP 三次握手完成 —— socket 的 connect 事件。≈ 1 个 RTT */
  tcp?: number;
  /** TLS 握手完成 —— socket 的 secureConnect 事件。纯 http 请求不会有 */
  tls?: number;
  /** 收到响应首字节 —— response 事件。扣掉建连后即服务端时间 */
  firstByte?: number;
  /** 响应体接收完毕 —— end 事件 */
  end?: number;
}

export interface Remote {
  address: string;
  port: number;
  /** 'IPv4' 或 'IPv6'。同一域名可能同时有两者，这里记录的是本次实际连上的那个 */
  family: string;
}

export interface ProbeResult {
  url: string;
  scheme: 'http' | 'https';
  remote?: Remote;
  /** ALPN 协商结果：'h2' 或 'http/1.1'。它决定同源并发能不能走到多路复用 */
  alpn?: string | null;
  /** 实际协商到的 TLS 版本，如 'TLSv1.3' */
  tlsProtocol?: string | null;
  statusCode?: number;
  /** 响应体字节数（解压后的长度，不等于 wire 上的字节数） */
  bytes?: number;
  phases: Phases;
}
