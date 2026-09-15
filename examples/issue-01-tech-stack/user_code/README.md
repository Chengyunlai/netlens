# user_code —— 使用者视角

这是本阶段的**设计验收入口**：不看对话、不看 issue，只跑这一条命令，
就应该能判断"选型可用"这件事成不成立。

## 最短路径

```bash
node examples/issue-01-tech-stack/user_code/main.ts https://example.com
```

实测输出：

```text
https://example.com
  状态码    200
  远端      104.20.23.154:443 (IPv4)
  请求协议  http/1.1
  TLS       TLSv1.3
  响应体    318 字节

各阶段时间戳（相对请求起点的毫秒偏移）
  dns        10.5 ms
  tcp        245.3 ms
  tls        1185.5 ms
  firstByte  1367.3 ms
  end        1368.8 ms
```

数字每次都会变——那是网络本身在变，不是程序不稳定。

## 连续调用路径

```text
main.ts
  └─ import { probe } from '../../../src/probe.ts'   ← 唯一的公开导入
       └─ await probe(url)                            ← 一次调用，返回一个结果对象
            └─ result.statusCode / result.remote / result.phases
```

三步，没有配置对象、没有工厂、没有依赖注入容器。
`probe()` 收一个 URL 字符串，还一个 `ProbeResult`。

## 为什么它足够清爽

- 公开 API 只有一个函数：`probe(url, options?)`。`options` 目前只有 `timeoutMs` 一项。
- 结果里每个字段都能追到协议层含义（映射表见 [`../core/README.md`](../core/README.md)）。
- 没有隐藏状态：每次调用新建 Agent，不复用连接，所以拿到的是干净的冷路径数字。

## 已知的粗糙处

`main.ts` 里的输出是临时拼的，只为看清各阶段时间戳——没有对齐处理、没有颜色、
不区分"建连成本"和"服务端时间"。

正式的终端渲染属于后续 issue，届时会整体替换掉这段输出。
现在把它写在这里，是为了避免它以后被误当成"最终形态"。
