/**
 * 第三层：TLS —— 一次真实握手，以及握手里到底协商了什么。
 *
 * 这一层不是"给 HTTP 加密"这么简单，它自己就是一个独立的协议：
 * 先协商版本和算法，再验证对方身份，最后交换密钥。做完这些才轮到 HTTP 说话。
 *
 * 这里用 tls.connect 而不是自己拼 ClientHello —— 自己实现一个 TLS 握手
 * 需要密码学原语，那已经越过了"学协议"的边界。但握手之后协商出来的每一项
 * 都被读出来了：版本、密码套件、ALPN、SNI、证书链。
 */

import tls from 'node:tls';
import type net from 'node:net';

export interface CertificateEntry {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
}

export interface TlsInfo {
  protocol: string | null;
  cipher: string | null;
  /** ALPN 协商结果：决定这条连接上跑 HTTP/1.1 还是 HTTP/2。 */
  alpn: string | null;
  /** SNI：客户端在明文阶段告诉服务端"我要访问哪个域名"。 */
  servername: string | null;
  authorized: boolean;
  authorizationError: string | null;
  chain: CertificateEntry[];
}

export interface TlsConnection {
  socket: tls.TLSSocket;
  handshakeMs: number;
  info: TlsInfo;
}

export interface TlsOptions {
  servername: string;
  /**
   * 客户端提议的协议列表。服务端从中挑一个。
   * 这里默认只提 http/1.1 —— 如果协商出 h2，手写的 HTTP/1.1 报文就对不上了。
   */
  alpn?: string[];
  /** 强制上限，用来实测 TLS 1.2 与 1.3 的握手往返差异。 */
  maxVersion?: 'TLSv1.2' | 'TLSv1.3';
  /** 是否校验证书。设为 false 只为观察自签名网站，不要在生产里这么干。 */
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
}

const formatDate = (value: string | undefined): string => {
  if (!value) return '未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
};

/**
 * 证书里的 CN 类型是 `string | string[]` —— 协议允许一张证书带多个同名条目。
 * 多数 CA 只填一个，但类型上必须处理，否则遇到多值证书会直接拿到一个数组。
 */
function commonName(value: string | string[] | undefined, fallback: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value !== undefined) return value;
  return JSON.stringify(fallback) ?? '（无可读名称）';
}

/**
 * 沿着 issuerCertificate 把证书链走完。
 *
 * getPeerCertificate(true) 返回的是一张链式表：每张证书里嵌着签发者的证书。
 * 必须防成环 —— 自签名证书的 issuer 就是它自己。
 */
function readChain(socket: tls.TLSSocket): CertificateEntry[] {
  const chain: CertificateEntry[] = [];
  const seen = new Set<string>();
  let certificate = socket.getPeerCertificate(true);
  let depth = 0;

  while (certificate && Object.keys(certificate).length > 0) {
    depth += 1;
    if (depth > 10) break;

    const fingerprint = certificate.fingerprint256 ?? certificate.fingerprint ?? `d${depth}`;
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);

    chain.push({
      subject: commonName(certificate.subject?.CN, certificate.subject),
      issuer: commonName(certificate.issuer?.CN, certificate.issuer),
      validFrom: formatDate(certificate.valid_from),
      validTo: formatDate(certificate.valid_to),
    });

    certificate = certificate.issuerCertificate as typeof certificate;
    if (certificate && certificate.issuerCertificate === certificate) break;
  }

  return chain;
}

/**
 * 在一条已建立的 TCP 连接上做 TLS 握手。
 *
 * 复用同一条 TCP 连接而不是让 tls.connect 自己建连，是为了让"TCP 花多久、
 * TLS 花多久"两段时间分得开 —— 这两段的优化方向完全不同。
 */
export function handshake(
  socket: net.Socket,
  options: TlsOptions,
): Promise<TlsConnection> {
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();

    const secured = tls.connect({
      socket,
      servername: options.servername,
      // 不显式给 servername 时，服务端不知道你要访问哪个域名，
      // 只能回默认证书（虚拟主机场景下往往是错的）。这就是 SNI 的作用。
      ALPNProtocols: options.alpn ?? ['http/1.1'],
      ...(options.maxVersion ? { maxVersion: options.maxVersion } : {}),
      ...(options.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
    });

    const timer = setTimeout(() => {
      secured.destroy();
      reject(new Error(`TLS 握手 ${timeoutMs} ms 未完成`));
    }, timeoutMs);

    secured.once('secureConnect', () => {
      clearTimeout(timer);
      const cipher = secured.getCipher();
      resolve({
        socket: secured,
        handshakeMs: performance.now() - startedAt,
        info: {
          protocol: secured.getProtocol(),
          cipher: cipher ? `${cipher.name} (${cipher.version})` : null,
          alpn: secured.alpnProtocol || null,
          servername: options.servername,
          authorized: secured.authorized,
          authorizationError: secured.authorizationError
            ? String(secured.authorizationError)
            : null,
          chain: readChain(secured),
        },
      });
    });

    secured.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
