# 项目事实

这份文档记录影响后续实现判断的**稳定事实**：目标、术语、边界、约束。
临时讨论和未确认的方案不写在这里。

最后更新：2026-09-15（issue-01 完成：技术选型落地，最小入口跑通）

## 项目目标

让"这个请求的网络层为什么慢"可以被直接回答。三条底线：

1. 结论必须可解释（指明属于哪一段）
2. 结论必须可执行（给出具体动作）
3. 结论必须带理论锚点（说清背后的网络原理）

完整的目标与非目标见 [README](../README.md)。

## 三个能力层

项目由三个能力层组成，**按顺序实现，不并行开工**：

| 层 | 命令 | 观测对象 | 依赖 |
| --- | --- | --- | --- |
| probe | `netlens probe <url>` | 一次请求的分层耗时 | 纯 Node，无浏览器 |
| page | `netlens page <url>` | 整页的连接图（多 Origin、连接数、关键路径） | 需要浏览器 / CDP |
| compare | `netlens compare <a> <b>` | 两次探测的差值 | 复用前两层的输出 |

当前阶段：**probe**。

## 术语

| 术语 | 含义 |
| --- | --- |
| **分层耗时（phases）** | 一次请求的时间被切成五段：DNS 解析 / TCP 握手 / TLS 握手 / 首字节（服务端）/ 传输 |
| **Connection Setup Tax** | DNS + TCP + TLS 之和。与响应内容无关，纯属建连"过路费"。每遇到一个新的 Origin 就要重付一次 |
| **冷请求 / 热请求** | 冷 = 新建连接的首次请求；热 = 复用已有连接的后续请求。两者的差值就是连接复用的收益 |
| **理论锚点** | 支撑一条诊断结论的网络原理，例如"TLS 1.3 握手 = 1 RTT，1.2 = 2 RTT" |
| **诊断规则** | 四元组：网络现象 → 性能后果 → 可执行动作 → 理论锚点。见 [CONTRIBUTING](../CONTRIBUTING.md) |

## 设计原则

- **观测与判断分离。** 探测层只负责拿到事实（各段耗时、是否复用连接、ALPN 结果），不知道什么算"好"或"坏"；诊断层是纯函数，只吃事实出结论，不碰网络；渲染层只负责呈现，不参与判断。
- **复用与否要硬证据。** 判断连接是否被复用，使用运行时提供的 `reusedSocket` 标志，不通过耗时推断。
- **失败要能定位到层。** 探测失败必须区分 DNS / TCP / TLS / HTTP，而不是抛一个笼统错误。

## 约束

- **运行时零第三方依赖。** 诊断工具应该能在任何机器上零安装运行；这也是它能进 CI 的前提。
- **当前阶段不引入浏览器。** probe 只使用 Node 内置的 `dns` / `net` / `tls` / `http` / `http2` 模块。
- **不乱发明指标。** 只使用协议与运行时真实提供的数据（socket 事件、TLS 信息、响应头）。

## 技术选型（已确定）

**路线 A —— TypeScript 源码 + Node 原生运行（开发期零构建）+ 发布时 `tsc` 编译 `dist`。**
决策过程与实测记录见 [issue #1](https://github.com/Chengyunlai/netlens/issues/1)。

以下几条是实测得出的约束，不要在重构时删掉：

- `tsconfig` 必须显式声明 `"types": ["node"]`。缺这一项时 `console` / `process` 报 `TS2584`，编译退出码变 2。
- devDependency 是两个：`typescript` + `@types/node`。
- 代码只能用可被类型剥离的语法（由 `erasableSyntaxOnly` 强制）：不能用 `enum` / `namespace` / 构造函数参数属性。
- 探测必须用独立定时器做总时长兜底。`request.setTimeout()` 只在 socket **已连接之后**才生效，保护不了建连阶段。

## 验证命令

```bash
node src/cli.ts example.com                            # 开发期直跑，无需构建
node examples/issue-01-tech-stack/user_code/main.ts    # 跑 example
npm run typecheck                                      # 类型检查（含 examples）
npm run build && node dist/cli.js example.com          # 验证发布产物
```

## 待定

- **包名**：暂用 `netlens` 作为工作名，发布前确认 npm 上是否可用。
- **测试框架 / 格式化工具**：有意延期。当前没有值得断言的纯逻辑，硬上会成为负担；等出现第一个真正的规则引擎再引入。

## 导航

```text
README → AGENTS.md → docs/context.md → examples/README.md → docs/implementation/<stage>.md
```
