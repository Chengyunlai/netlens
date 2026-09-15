# netlens

> 把 DNS、TCP、TLS、连接复用这些网络层细节，翻译成 Web 性能问题与优化建议。

`netlens` 是一个终端诊断工具。它不给你一个性能评分，而是回答一个更具体的问题：

**这一个请求的网络时间，到底花在哪一段，以及该改什么。**

```bash
npx netlens probe https://example.com
```

```text
  Network Timeline  (冷请求，首次访问)
  DNS          6.21 ms  ████████
  TCP          15.9 ms  ████████████████████
  TLS         22.37 ms  ████████████████████████████
  TTFB*       20.48 ms  ██████████████████████████
  Transfer     1.44 ms  ██

  Connection Setup Tax  44.48 ms   = DNS + TCP + TLS，每个新 Origin 都要重付一次

  Diagnosis
  ! 建连成本占整次请求的 67%
    → 让关键资源复用同一条连接，或把服务推近用户
  ✓ 连接复用生效（keep-alive 正常）
    热请求复用同一条 TCP 连接，TTFB 64.95ms → 21.56ms
```

> 上面的输出取自 v0 原型的一次真实运行（`chengyunlai.top`）。正式实现会重做渲染层，但这个"分层 + 冷热对比 + 诊断"的结构是目标形态。

## 为什么需要它

现有工具各自覆盖了一段，但中间有一块空白：

| 工具 | 擅长 | 不解决的问题 |
| --- | --- | --- |
| Lighthouse | LCP / CLS / 性能评分 | 网络层"为什么慢"不够直观 |
| httpstat / curl | 单请求的 DNS → TCP → TLS → TTFB | 只覆盖单请求，输出偏底层 |
| autocannon | HTTP 压测 | 不分析页面加载过程 |
| Chrome DevTools | 网络瀑布图 | 在 GUI 里，需要人工解读 |
| sitespeed.io | 整页测试 / HAR / CWV | 功能很重，学习成本高 |

`netlens` 填的是中间这块：**把已有的底层网络数据做因果解释**，而不是发明新的性能指标。

## 目标

1. **可解释**：每一个数字都能回答"它属于哪一段、为什么产生"。
2. **可执行**：每条结论都给出具体动作，而不是"你的页面慢"。
3. **可学习**：每条诊断规则都带理论锚点（例如"TLS 1.3 握手 = 1 RTT，1.2 = 2 RTT"），让工具本身成为网络知识的入口。
4. **可进 CI**：支持输出 JSON 与基线对比，让网络层回归能被门禁拦住。

## 非目标

明确不做，以避免和成熟工具正面竞争：

- 不做性能评分（Lighthouse 已经很成熟）
- 不做压测（autocannon 已经很好）
- 不做前端渲染指标（DOM / CSS / JS 执行成本）
- 不自己实现 HTTP/3 客户端（第一版依靠浏览器获取真实信息）

## 路线图

| 阶段 | 命令 | 状态 |
| --- | --- | --- |
| 一、单请求分层探针 | `netlens probe <url>` | 当前阶段 |
| 二、整页连接图 | `netlens page <url>` | 计划 |
| 三、CI 预算对比 | `netlens compare <a> <b>` | 计划 |

**当前阶段只做第一个。** 理由：它是后两个阶段的度量地基——整页模式要算"每个 Origin 的建连开销"，CI 对比要比"建连成本的差值"，都依赖同一套分层计时与冷热对比口径。先把度量定义钉死，后面不返工。

## 快速开始

> 项目处于起步阶段，尚未发布到 npm，本地运行命令待技术选型确定后补全。
> 参与开发请先读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 项目导航

| 想看什么 | 去哪里 |
| --- | --- |
| 怎么贡献 | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| 项目事实、术语、模块边界 | [docs/context.md](./docs/context.md) |
| AI / 协作者的工作规则 | [AGENTS.md](./AGENTS.md) |
| 各阶段可运行示例 | [examples/README.md](./examples/README.md) |
| 阶段实现记录 | [docs/implementation/](./docs/implementation/) |

## 许可

[MIT](./LICENSE)
