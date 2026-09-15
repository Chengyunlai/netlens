# core —— 核心实现映射

本阶段的核心代码在 `src/`，不在本目录。这里说明它们各自承担什么，以及"为什么必须这样写"。

## 真实源码映射

| 文件 | 职责 | 关键点 |
| --- | --- | --- |
| `src/types.ts` | 只放类型，无任何运行时代码 | `Phases` 存的是**时间戳**而不是耗时 |
| `src/probe.ts` | 发一次请求，记录各阶段时间戳 | 所有时间点来自 socket 真实事件，不从总耗时反推 |
| `src/cli.ts` | 参数解析、版本检查、文本输出 | 中文字符占两列，`padEnd` 按字符数算会对不齐 |

## `tsconfig.json` 里为什么必须有那几行

```jsonc
"rewriteRelativeImportExtensions": true,  // 源码写 './probe.ts'，编译后自动变 './probe.js'
"allowImportingTsExtensions": true,       // 允许 import 语句里带 .ts 后缀
"erasableSyntaxOnly": true,               // 禁止 enum / namespace / 参数属性等"不可剥离"语法
"types": ["node"]                         // 不写这一项，console / process 全报 TS2584
```

前三行合起来解决一个问题：**让同一份源码既能被 Node 直接运行，又能被 `tsc` 编译成可执行的 JS**。
`erasableSyntaxOnly` 是一道保险——它保证代码只用「类型注解法」，Node 的类型剥离才能原样跑起来。

最后一行是实测踩出来的：只装 `@types/node` 不够，必须在 `compilerOptions` 里显式声明，
否则 `console` / `process` 报 `TS2584`，编译退出码变成 2。

## 三个值得留意的实现细节

### 1. `lookup` 事件里读不到远端地址

```ts
socket.once('lookup', () => {
  phases.dns = now() - startedAt;   // 这里 socket.remotePort 是 undefined
});

socket.once('connect', () => {
  result.remote = { address: socket.remoteAddress, port: socket.remotePort };  // 要在这里读
});
```

`lookup` 触发时连接尚未建立，`remoteAddress` / `remotePort` 都还是 `undefined`，
读出来会变成 `0`。这个 bug 在第一次运行时真的出现了——输出里写着 `:0` 端口。

### 2. 超时不能用 `request.setTimeout()`

它的语义是"socket 空闲超时"，而且**只在 socket 已连接之后才开始生效**。
可最需要保护的恰恰是"连都连不上"的那一段：SYN 被丢弃时，内核会重试到 75 秒左右。

所以这里用的是独立定时器 + `request.destroy()`。实测效果：3 秒上限的探测，
3009 ms 返回；15 秒默认值，15.096 秒返回。

### 3. 为什么固定只声明 `ALPNProtocols: ['http/1.1']`

Node 的 `http` 模块只懂 HTTP/1.1 的报文格式。如果在这里声明 `h2` 并且真的协商成功，
请求反而会因为格式不符而失败。

因此输出里的「请求协议」如实显示的是**本次请求实际使用的协议**，
它**不等于**"这个站点只支持 http/1.1"。要回答后者，需要一次独立的协商握手——
那是后续 issue（协议探测）的事。

## 失败层级是怎么推断的

`ProbeError.layer` 不依赖错误码的完备列表（错误码在各平台差异很大），
而是看时间线推进到哪里断掉：

```text
ENOTFOUND / EAI_AGAIN        → dns
tcp 时间戳为空                → tcp
firstByte 时间戳为空          → tls
其余                          → http
```

实测三例：不存在的域名 → `dns`；`https://127.0.0.1:1` → `tcp`；
SYN 被丢弃而超时 → `tcp`。
