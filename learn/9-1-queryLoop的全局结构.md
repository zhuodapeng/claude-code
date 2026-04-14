# 9-1 queryLoop() 的全局结构：一个 while(true) 循环

## 本节要解决的问题

进入 `query()` 调用之后，发生了什么？

从 `submitMessage()` 的视角看，`query()` 是一个黑盒：传进去消息历史和 system prompt，yield 出来流式消息，最终返回一个终止原因。但这个黑盒内部的结构，是理解 Claude Code 核心工作方式的关键。

这一节的任务是**揭开黑盒**——展示 `queryLoop()` 的整体骨架，理解为什么它被设计成一个 `while(true)` 循环，以及这个循环里携带了哪些状态。

**文件：[src/query.ts](../src/query.ts#L219-L1729)**

---

## 核心结构：query() 与 queryLoop() 的分离

`query()` 函数本身很短，它是 `queryLoop()` 的薄包装：

**文件：[src/query.ts](../src/query.ts#L219-L239)**

```typescript
export async function* query(
  params: QueryParams,
): AsyncGenerator<...> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  
  // 只在正常返回时执行（不在 throw 或 .return() 时执行）
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

为什么分成两层？因为命令生命周期通知（`notifyCommandLifecycle`）必须**只在 queryLoop 正常完成时**执行，不能在异常时执行。用 `yield*` 委托 + 后续代码，比 try/finally 更清晰地表达了这个意图：`yield*` 结束后的代码不会在 generator 被强制关闭（`.return()`）时运行。

---

## queryLoop() 的骨架

**文件：[src/query.ts](../src/query.ts#L241-L1729)**

```typescript
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<..., Terminal> {
  
  // === 初始化（只执行一次）===
  const { systemPrompt, userContext, ... } = params
  let state: State = { messages: params.messages, ... }
  
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(...)
  
  // === 主循环 ===
  while (true) {
    // 1. 解构本次迭代的状态
    let { toolUseContext } = state
    const { messages, autoCompactTracking, ... } = state
    
    // 2. yield stream_request_start 信号
    yield { type: 'stream_request_start' }
    
    // 3. 准备消息（compact、budget 检查等）
    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]
    messagesForQuery = await applyToolResultBudget(...)
    // ... 各种压缩优化 ...
    
    // 4. 调用 API，处理流式响应
    for await (const message of deps.callModel(...)) {
      yield message          // 转发给上层
      if (message.type === 'assistant' && has_tool_use) {
        needsFollowUp = true
        toolUseBlocks.push(...)
      }
    }
    
    // 5. 如果没有工具调用 → 检查终止条件
    if (!needsFollowUp) {
      // 各种错误恢复路径（prompt-too-long、max-output-tokens...）
      // 执行 stop hooks
      return { reason: 'completed' }  // ← 退出循环
    }
    
    // 6. 执行工具调用
    for await (const update of runTools(...)) {
      yield update.message  // 转发工具结果
      toolResults.push(...)
    }
    
    // 7. 收集附件（排队命令、记忆注入等）
    for await (const attachment of getAttachmentMessages(...)) {
      yield attachment
      toolResults.push(attachment)
    }
    
    // 8. 检查 maxTurns
    if (maxTurns && nextTurnCount > maxTurns) {
      return { reason: 'max_turns' }
    }
    
    // 9. 构建下一次迭代的状态
    state = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      ...
      transition: { reason: 'next_turn' },
    }
    // continue → 回到 while(true) 顶部
  }
}
```

这就是整个循环的骨架。注意它的核心结构：**每次迭代处理一个"Claude 说话 + 工具执行"的周期**，然后把结果折叠进新的消息历史，开始下一轮。

---

## State 对象：跨迭代的可变状态

循环的一个设计亮点是把所有**跨迭代的可变状态**集中在 `State` 对象里：

**文件：[src/query.ts](../src/query.ts#L203-L217)**

```typescript
type State = {
  messages: Message[]              // 当前消息历史
  toolUseContext: ToolUseContext   // 工具使用上下文（含 AppState 等）
  autoCompactTracking: AutoCompactTrackingState | undefined  // 自动压缩追踪
  maxOutputTokensRecoveryCount: number    // max_output_tokens 恢复计数
  hasAttemptedReactiveCompact: boolean    // 是否已尝试过 reactive compact
  maxOutputTokensOverride: number | undefined  // 输出 token 覆盖值
  pendingToolUseSummary: Promise<...> | undefined  // 工具摘要（异步）
  stopHookActive: boolean | undefined    // stop hook 是否激活
  turnCount: number                      // 当前轮次计数
  transition: Continue | undefined       // 上一次迭代的继续原因
}
```

每次需要"继续循环"时，代码这样做：

```typescript
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: ...,
  transition: { reason: 'next_turn' },  // 记录为什么继续
  ...
}
state = next
// continue 语句（隐式，因为是 while(true) 末尾）
```

或者更明显的 `continue` 语句（用于恢复路径）：

```typescript
state = next
continue  // 跳回 while(true) 顶部
```

**为什么用 State 对象，而不是单独的变量？**

这是个精心的设计。如果用 9 个单独的 `let` 变量，每个"继续站点"（continue site）都需要单独更新每个变量，容易遗漏。用一个对象，每次 `state = { ... }` 是一个完整替换，TypeScript 的类型检查会确保所有字段都被赋值。代码注释里直接说了这个原因：

```typescript
// Continue sites write `state = { ... }` instead of 9 separate assignments.
```

**`transition` 字段的价值**

`transition` 记录了"为什么进行这次迭代"：`next_turn`（正常工具循环）、`max_output_tokens_recovery`（token 超限恢复）、`reactive_compact_retry`（压缩后重试）等。这个字段让测试可以断言恢复路径是否触发——不需要解析消息内容，只需检查 `state.transition.reason`。

---

## 为什么是 while(true)，而不是递归？

早期版本的 `queryLoop` 是**递归**的——工具执行完成后，调用自身开始下一轮。这个模式直观，但有一个根本性缺陷：

**递归会有调用栈深度限制。**

每轮工具调用 = 一层递归。一个 50 轮的任务 = 50 层调用栈。对于长任务，栈溢出是真实风险。

但等等——JavaScript 的异步 generator 也是有调用栈的？

是的，但 `while(true)` 的每次迭代在同一层调用栈上运行。`continue` 语句不增加栈深度，而函数调用会。所以从递归改成循环，解决了栈溢出问题，同时保持了相同的语义。

```
递归版本：
queryLoop(turn=1)
  → queryLoop(turn=2)
    → queryLoop(turn=3)
      → ... (栈深度线性增长)

循环版本：
queryLoop() {
  while(true) {
    // turn=1 迭代
    state = next  // turn=2
    // turn=2 迭代
    state = next  // turn=3
    // turn=3 迭代
    ...           // 栈深度恒定为 1
  }
}
```

---

## "Continue 路径"的完整分类

`queryLoop` 里有多个 `continue` 语句（或循环末尾隐式继续），每个代表一种"继续处理"的情形：

```
continue 路径
├── next_turn（正常）
│   └── 工具调用完成，把工具结果追加到消息历史，继续下一轮 API 调用
│
├── max_output_tokens_escalate
│   └── 首次 hit max_output_tokens，以更大 token 限制重试同一请求
│
├── max_output_tokens_recovery
│   └── 注入"从中断处继续"的恢复消息，开始新一轮对话
│
├── reactive_compact_retry
│   └── context 超长，对消息历史做 reactive compact，重试
│
├── collapse_drain_retry
│   └── 上下文折叠（context collapse）释放了空间，重试
│
├── stop_hook_blocking
│   └── PostToolUse hook 返回了"必须修正"的错误，重试
│
└── token_budget_continuation
    └── 500k token budget 允许继续，注入 nudge 消息继续生成
```

每种 continue 路径都是一个**恢复或优化策略**，不是 bug 处理，而是系统设计的一部分。它们让 Claude Code 能够优雅地处理各种边界情况，而不是直接报错。

---

## yield 的三种对象

`queryLoop` yield 的内容有三类，上层（`QueryEngine.submitMessage()`）会根据类型做不同处理：

| yield 内容 | 来源 | 上层的处理 |
|---|---|---|
| `StreamEvent`（如 `text_delta`） | API 流式响应 | 转发给 TUI 渲染或 SDK 调用者 |
| `Message`（如 `AssistantMessage`、`UserMessage`） | 工具执行结果、错误消息 | 持久化到 transcript，转发给上层 |
| `RequestStartEvent`（`stream_request_start`） | 每次 API 调用前 | 触发 TUI 的"加载中"动画 |

`yield*`（委托 yield）意味着 `query()` 的所有 yield 会直接穿透到 `submitMessage()` 的 `for await` 循环里，然后再穿透到 `QueryEngine` 的 SDK 消息流。

---

## 全局流程图

```
query(params)
    │
    ├─ consumedCommandUuids = []
    │
    └─ yield* queryLoop(params, consumedCommandUuids)
              │
              ├─ [初始化] state = { messages, toolUseContext, ... }
              │  pendingMemoryPrefetch = startRelevantMemoryPrefetch()
              │
              └─ while(true) {
                   │
                   ├─ 解构 state
                   ├─ yield stream_request_start
                   ├─ 准备 messagesForQuery（compact、budget 检查）
                   │
                   ├─ for await (message of callModel(...)) {
                   │    yield message
                   │    记录 toolUseBlocks, needsFollowUp
                   │  }
                   │
                   ├─ if (!needsFollowUp) {
                   │    [恢复检查 / stop hooks]
                   │    return { reason: 'completed' }    ← 退出
                   │  }
                   │
                   ├─ for await (update of runTools(...)) {
                   │    yield update.message
                   │    toolResults.push(...)
                   │  }
                   │
                   ├─ for await (att of getAttachmentMessages(...)) {
                   │    yield att
                   │    toolResults.push(att)
                   │  }
                   │
                   ├─ if (maxTurns reached) return { reason: 'max_turns' }
                   │
                   └─ state = { messages: [..., ...toolResults], ... }
                      // 回到 while(true) 顶部
                 }
```

---

## 本节小结

- `queryLoop()` 的核心是一个 `while(true)` 循环，每次迭代处理"一轮 API 调用 + 工具执行"
- 所有跨迭代状态集中在 `State` 对象，每个 continue 点用 `state = next` 原子替换整个状态
- 用循环而非递归，根本原因是避免调用栈深度随轮次线性增长
- 有 6+ 种 continue 路径，每种对应一种恢复/优化策略
- 循环的终止条件是 `return { reason: ... }`，包括 `completed`、`max_turns`、`aborted` 等

## 前后呼应

- `queryLoop` 接收的 `params` 来自 **[8-4 节](./8-4-submitMessage的前半程.md)** 的 `submitMessage()` 构建
- 循环里调用的 `callModel` 是下一节要深入讲解的 `claude()` 函数

## 下一节预告

`callModel` 调用 Anthropic API 的具体过程是什么？从构建请求参数到接收流式响应，中间经历了哪些关键步骤？

➡️ [下一节：9-2 调用 Anthropic API](./9-2-调用Anthropic-API.md)
