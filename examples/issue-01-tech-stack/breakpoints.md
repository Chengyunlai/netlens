# 关键断点

用**稳定符号**定位（函数名、事件名），不要用行号——行号会漂移。

## 1. 版本检查

- **位置**：`src/cli.ts` → `assertRuntime()`
- **观察**：`process.versions.node`、`MIN_NODE_MAJOR`
- **预期**：22.22.2 ≥ 22 时不进分支；把 `MIN_NODE_MAJOR` 临时改成 99，会打印两行提示并以退出码 1 结束

## 2. 请求参数组装

- **位置**：`src/probe.ts` → `createAgent()`
- **观察**：返回的 Agent 的 `options.ALPNProtocols`
- **预期**：`['http/1.1']`，`keepAlive` 为 `false`（本阶段只测冷路径）

## 3. DNS 完成

- **位置**：`src/probe.ts` → `socket.once('lookup')`
- **观察**：`phases.dns`
- **预期**：首次请求有值（如 12.9）
- **易错点**：在这个回调里读 `socket.remotePort` 会得到 `undefined`

## 4. TCP 完成

- **位置**：`src/probe.ts` → `socket.once('connect')`
- **观察**：`phases.tcp`、`result.remote`
- **预期**：`remote.port` 是 `443`（**不是 0**），`remote.family` 为 `IPv4` 或 `IPv6`

## 5. TLS 完成

- **位置**：`src/probe.ts` → `socket.once('secureConnect')`
- **观察**：`phases.tls`、`result.tlsProtocol`、`result.alpn`
- **预期**：`TLSv1.3`、`http/1.1`
- **注意**：纯 `http://` 请求不会命中这个断点，`phases.tls` 保持为空是正常的

## 6. 超时兜底

- **位置**：`src/probe.ts` → `setTimeout` 回调内部的 `request.destroy(timeout)`
- **观察**：`ProbeError.message`、`ProbeError.layer`
- **预期**：`探测在 15000 ms 内没有完成`，`layer` 为 `tcp`
- **复现**：
  ```bash
  node --input-type=module -e "
  import { probe } from './src/probe.ts';
  const t = Date.now();
  try { await probe('https://example.com:9', { timeoutMs: 3000 }); }
  catch (e) { console.log(Date.now() - t, e.layer, JSON.stringify(e.message)); }
  "
  ```
  预期首个数约 3009

## 7. 失败层级推断

- **位置**：`src/probe.ts` → `inferLayer()`
- **观察**：`ProbeError.layer`
- **预期**：
  - `https://this-domain-should-not-exist-netlens.invalid` → `dns`
  - `https://127.0.0.1:1` → `tcp`
  - `https://example.com:9`（SYN 被丢弃）→ `tcp`
