# 10-1 QueryEngine vs query()：为什么需要两层

## 本节要解决的问题

你已经深度理解了 `queryLoop()`——它是一个状态机，运行一个"用户问题→Claude 回答"的完整交互。

但 `queryLoop()` 是私有函数，外面还包了一层 `query()`，`query()` 外面还包了一层 `QueryEngine`。

**为什么需要两层封装？`query()` 做了什么，`QueryEngine` 又做了什么？**

---

## 分层示意

```
┌──────────────────────────────────────────────────────────────────┐
│  QueryEngine                                                     │
│  "会话状态 + 多轮对话 + SDK 消息格式化"                            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  submitMessage()                                           │  │
│  │  "一轮对话的完整编排（12步）"                                │  │
│  │                                                            │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  query()                                             │  │  │
│  │  │  "command lifecycle wrapper"                          │  │  │
│  │  │                                                      │  │  │
│  │  │  ┌──────────────────────────────────────────────┐    │  │  │
│  │  │  │  queryLoop()                                 │    │  │  │
│  │  │  │  "while(true) 状态机"                        │    │  │  │
│  │  │  └──────────────────────────────────────────────┘    │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

从内到外：
- `queryLoop()`：状态机本体，处理 Claude 的一次"任务完成"过程（可能包含多轮工具调用）
- `query()`：给 queryLoop 加上 "command 生命周期通知" 的薄层包装
- `QueryEngine.submitMessage()`：完整的一次用户交互，包含消息历史管理、格式转换、transcript 持久化
- `QueryEngine` 类本身：持有跨轮对话的会话状态（消息历史、权限记录、token 用量统计）

---

## 第一层包装：query()

**文件：[src/query.ts](../src/query.ts#L219-L239)**

```typescript
export async function* query(
  params: QueryParams,
): AsyncGenerator<..., Terminal> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  
  // 只有 queryLoop 正常返回（不是 throw 或 .return()）才会执行到这里
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

`query()` 做的事情**极少**：把 `consumedCommandUuids` 数组传入 queryLoop，在正常完成时通知 command lifecycle。

`consumedCommandUuids` 是 queryLoop 运行过程中"消费掉"的命令 UUID（用户输入的命令，比如排队中的消息）。只有在正常完成时才通知它们 `completed`。如果 queryLoop 抛出异常或被 `.return()` 强制关闭，这段代码不会执行——命令不会收到 `completed` 通知，这是正确的（中途失败，命令未完成）。

为什么需要独立的 `query()` 而不是直接调用 `queryLoop()`？因为 command lifecycle 通知属于"外层关注点"——queryLoop 只管状态机的运行，它不应该知道"命令生命周期"是什么概念。职责分离。

---

## 第二层：QueryEngine 的职责

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L184-L207)**

`QueryEngine` 是**会话级别的状态持有者**。它持有的状态跨越多次 `submitMessage()` 调用（跨越多轮对话）：

```typescript
export class QueryEngine {
  private config: QueryEngineConfig      // 工具、命令、权限等配置（整个会话不变）
  private mutableMessages: Message[]     // ← 消息历史（每轮 append）
  private abortController: AbortController  // 取消信号
  private permissionDenials: SDKPermissionDenial[]  // 本轮被拒绝的工具列表
  private totalUsage: NonNullableUsage   // 累计 token 用量（跨轮）
  private readFileState: FileStateCache  // 文件缓存（跨轮）
  private discoveredSkillNames: Set<string>  // 本轮发现的 skill
  private loadedNestedMemoryPaths: Set<string>  // 已加载的 MEMORY.md 路径
```

**`mutableMessages`** 是最重要的——它是整个对话的消息历史，每次 `submitMessage()` 都会往里追加新消息。这份历史是 Claude 的"记忆"：没有它，每次调用都是从零开始的新对话。

---

## 为什么需要 QueryEngine 这一层？

### 问题：query() 是无状态的

`queryLoop()` 和 `query()` 都是**无状态函数**——每次调用结束后，它们的状态就消失了。如果你直接反复调用 `query()`，每次都需要传入完整的消息历史，否则 Claude 不知道之前说了什么。

```typescript
// 如果没有 QueryEngine，SDK 调用者得这样做：
const messages1 = []
const result1 = yield* query({ messages: messages1, ... })
// 收集新消息
const messages2 = [...messages1, ...newMessages]
const result2 = yield* query({ messages: messages2, ... })
// ... 每次手动管理消息历史
```

### 解决方案：QueryEngine 持有 mutableMessages

```typescript
// 有了 QueryEngine：
const engine = new QueryEngine(config)

// 第一轮
for await (const msg of engine.submitMessage("帮我读取 main.ts")) { ... }

// 第二轮（消息历史已自动累积）
for await (const msg of engine.submitMessage("现在修改第 42 行")) { ... }

// 第三轮（Claude 记得前两轮的上下文）
for await (const msg of engine.submitMessage("运行单元测试")) { ... }
```

`QueryEngine` 把消息历史的管理从调用者手里"接管"过来，调用者只需要 `submitMessage()` 即可。

---

## 两层的分工总结

| 关注点 | query() | QueryEngine |
|---|---|---|
| 状态机运行 | 转发给 queryLoop | — |
| Command 生命周期通知 | ✓ | — |
| 消息历史管理 | 接收 params 就用 | 跨轮持久化 mutableMessages |
| SDK 消息格式化 | 原始内部格式 | 转换为 SDKMessage |
| Token 用量统计 | — | 累计 totalUsage |
| 权限拒绝记录 | — | 累计 permissionDenials |
| 文件缓存 | — | 持有 readFileState |
| Transcript 持久化 | — | recordTranscript() |
| 系统初始化消息 | — | yield system/init |

一句话：`query()` 是"把 queryLoop 的结果暴露出去"，`QueryEngine` 是"把一系列 query() 调用管理成一个会话"。

---

## submitMessage() 中的双重 processUserInputContext

在 `submitMessage()` 里，`processUserInputContext` 被构建了两次——这是一个容易让人困惑的细节：

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L335-L395)**

第一次：处理斜杠命令时用

```typescript
let processUserInputContext: ProcessUserInputContext = {
  messages: this.mutableMessages,
  setMessages: fn => {
    this.mutableMessages = fn(this.mutableMessages)  // ← 允许 /slash-command 修改消息历史
  },
  ...
}
```

第二次：实际调用 query() 时用

```typescript
processUserInputContext = {
  messages,  // ← 快照：不再允许修改
  setMessages: () => {},  // ← no-op：后续不允许再修改
  ...
}
```

为什么两次？斜杠命令（`/clear`、`/compact` 等）可能需要修改消息历史（比如 `/force-snip` 截断历史），所以第一次的 `setMessages` 是真实的写入操作。但在进入 `query()` 主循环之后，消息历史就不应该再被从"外部"修改了（queryLoop 内部会累积消息，但那是受控的），所以第二次的 `setMessages` 变成 no-op。

---

## QueryEngine vs REPL.tsx：两套调用路径

Claude Code 有两套使用路径：

```
SDK 模式：
  SDK 调用者 → QueryEngine.submitMessage() → query() → queryLoop()

TUI 模式：
  REPL.tsx (ask()) → query() → queryLoop()
                            ↑
              （直接调用 query()，不通过 QueryEngine）
```

TUI 模式的 REPL 里，消息历史由 `AppState.mutableMessages` 管理（React state），`ask()` 函数直接调用 `query()`，传入当时的消息历史快照。每次用户输入后，REPL 从 query() 收集新消息，自己更新 AppState。

SDK 模式由 QueryEngine 封装了消息历史管理，调用者不需要直接操作 AppState。

**同一个 `query()` 函数，两套调用模式——这是设计一致性的体现。** queryLoop 的逻辑只写了一次。

---

## 本节小结

- `query()` 是 queryLoop() 的薄层封装，只加了 command lifecycle 通知
- `QueryEngine` 是多轮对话的会话管理器，核心是持有 `mutableMessages`（消息历史）
- `QueryEngine` 还负责 token 统计、权限记录、文件缓存、transcript 持久化、SDK 消息格式化
- TUI 模式直接调用 `query()`，消息历史由 AppState 管理；SDK 模式通过 QueryEngine 管理
- 分层的意义：职责分离——状态机的运行（queryLoop）、单轮 command 通知（query）、多轮会话管理（QueryEngine）各司其职

## 前后呼应

- `submitMessage()` 的完整 12 步流程在 **[8-4 节](./8-4-submitMessage的前半程.md)** 已讲解前半段
- REPL.tsx 的 `ask()` 直接调用 `query()` 的模式在 **[6-5 节](./6-5-启动模式分支.md)** 有对应讲解

## 下一节预告

`QueryEngine` 的 `mutableMessages` 是整个对话的心脏。它什么时候增长，什么时候被压缩，什么时候被截断？

➡️ [下一节：10-2 消息历史（mutableMessages）的生命周期](./10-2-消息历史的生命周期.md)
