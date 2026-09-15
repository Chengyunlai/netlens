# 阶段示例索引

这里收录每个阶段**可运行**的示例。示例不是教程，而是"这个阶段到底做了什么"的可验收入口。

## 写法约定

每个阶段一个目录，命名 `examples/<stage-id>-<slug>/`。

`<stage-id>` **优先使用 issue 编号**（如 `issue-01`）；没有 issue 时使用阶段编号（如 `stage-01`）。目录一旦被记录引用就不要改名——如果 issue 编号是后来才有的，保留原目录名，在下面的索引里补上编号。

```text
examples/
├── README.md                        本索引
└── issue-01-tech-stack/
    ├── README.md                    验证什么、不验证什么
    ├── user_code/
    │   ├── README.md                使用者视角与最短公开 API 路径
    │   └── main.*                   使用者真正运行的代码
    ├── core/
    │   ├── README.md                核心代码与真实源码的映射
    │   └── ...                      必要时放最小核心代码 / fixture
    └── breakpoints.md               断点较多时单独拆出
```

每个示例的 README 至少写清：

- 它验证哪个阶段，以及**明确不验证什么**
- 一条最短启动命令、一个具体输入、一个具体输出
- `user_code/` 从公开导入到真实结果的连续调用路径
- 关键断点的稳定符号、观察变量和预期值
- 使用的实现 commit（C1）和记录 commit（C2），或注明仍未提交

## 索引

| 阶段 / Example | Issue | 运行命令 | 预期结果 | 实现记录 | Commit |
| --- | --- | --- | --- | --- | --- |
| `issue-01-tech-stack` | [#1](https://github.com/Chengyunlai/netlens/issues/1) | _待实现_ | `node src/cli.ts <url>` 打印五段分层耗时 | _待补_ | _待补_ |

> 当前状态：`issue-01` 处于"等待技术选型确认"，尚未开始实现。
