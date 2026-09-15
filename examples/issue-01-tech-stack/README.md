# issue-01-tech-stack

验证 [issue #1](https://github.com/Chengyunlai/netlens/issues/1)：确定第一阶段语言与构建路线。

## 验证什么

**"克隆后无需构建即可运行"这句承诺成立。**

拆成四件可独立观察的事：

| 验证项 | 怎么验 | 结果 |
| --- | --- | --- |
| 源码直接运行 | `node src/cli.ts example.com` | 通过，前后没有任何 install / build |
| 发布产物可用 | `npm run build` 后 `node dist/cli.js example.com` | 通过，产物里 `from './probe.ts'` 已重写为 `from './probe.js'` |
| 零运行时依赖 | 检查 `package.json` 的 `dependencies` | 通过，该字段不存在 |
| 版本过低有提示 | 临时把下限改成 99 后运行 | 通过，输出两行可读提示，退出码 1 |

## 明确不验证什么

- 诊断规则（网络现象 → 性能后果 → 可执行动作 → 理论锚点）—— 后续 issue
- 冷热请求对比、连接复用判定 —— 后续 issue
- 整页连接图（多 Origin、连接数、关键路径）—— 后续阶段
- HTTP/2 / HTTP/3 的协商探测 —— 后续 issue
- 终端渲染的视觉设计（对齐、颜色、图表）—— 后续 issue

## 一条最短启动命令

```bash
node examples/issue-01-tech-stack/user_code/main.ts https://example.com
```

**一个具体输入**：一个 URL。
**一个具体输出**：状态码、远端地址、TLS 版本，以及五个阶段的时间戳。

## 目录

| 路径 | 作用 |
| --- | --- |
| `user_code/` | 使用者视角：调用公开 API `probe()` 的最短路径，是本阶段的**设计验收入口** |
| `core/` | 核心实现与真实源码的映射，含三个"为什么必须这样写"的配置解释 |
| `breakpoints.md` | 七个关键断点的稳定符号、观察变量与预期值 |

## 关联

- Issue：[#1](https://github.com/Chengyunlai/netlens/issues/1)
- 实现记录：[`docs/implementation/issue-01-tech-stack.md`](../../docs/implementation/issue-01-tech-stack.md)
- Commit：实现提交 C1、记录提交 C2（提交后回填）
