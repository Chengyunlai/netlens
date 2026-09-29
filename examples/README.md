# 阶段示例索引

这里收录**可运行**的示例。示例不是教程，而是"这件事到底做成了什么"的可验收入口。

示例分两类，命名与分类规则见 [AGENTS.md 的 Example 归档](../AGENTS.md#example-归档)：

| 类别 | 前缀 | 是做什么的 |
| --- | --- | --- |
| 产品阶段示例 | `issue-<NN>-` / `stage-<NN>-` | 路线图上的一个阶段，是设计验收入口。`stage-<NN>` 的 NN 只是示例序号，不是路线图阶段号 |
| 学习层示例 | `raw-` | 不对应阶段。把封装拆开，用低层模块重做一遍，目的是暴露协议细节 |

## 写法约定

两类示例共用同一套内部结构：

```text
examples/
├── README.md                        本索引
├── issue-01-tech-stack/             产品阶段示例
│   ├── README.md                    验证什么、不验证什么
│   ├── user_code/                   最短可运行路径（设计验收入口）
│   ├── core/                        核心实现与真实源码的映射
│   └── breakpoints.md               断点较多时单独拆出
└── raw-network/                     学习层示例
    ├── README.md                    看什么、学到什么
    ├── user_code/main.ts            组装入口
    └── core/                        四层原始实现
```

目录一旦被记录引用就不要改名——如果 issue 编号是后来才有的，保留原目录名，在下面的索引里补上编号。

每个示例的 README 至少写清：

- 它验证哪个阶段，以及**明确不验证什么**
- 一条最短启动命令、一个具体输入、一个具体输出
- `user_code/` 从公开导入到真实结果的连续调用路径
- 关键断点的稳定符号、观察变量和预期值
- 使用的实现 commit（C1）和记录 commit（C2），或注明仍未提交

## 索引

| 阶段 / Example | Issue | 运行命令 | 预期结果 | 实现记录 | Commit |
| --- | --- | --- | --- | --- | --- |
| `issue-01-tech-stack` | [#1](https://github.com/Chengyunlai/netlens/issues/1) | `node examples/issue-01-tech-stack/user_code/main.ts https://example.com` | 打印状态码、远端地址、TLS 版本与五个阶段的时间戳 | [`docs/implementation/issue-01-tech-stack.md`](../docs/implementation/issue-01-tech-stack.md) | `a9dba47` |
| `raw-network` | — | `node examples/raw-network/user_code/main.ts example.com` | 打印 DNS / TCP / TLS / HTTP 四层各自看到的报文、耗时与系统行为 | 就地记录：[`examples/raw-network/README.md`](./raw-network/README.md) | _未提交_ |

> 当前状态：`issue-01` 已合并进 `main`，产品线有可运行代码。`raw-network` 是学习层示例，本地已跑通、尚未提交。
> 下一个产品阶段是单请求分层探针的完整版本（诊断规则、冷热对比、终端渲染）。
