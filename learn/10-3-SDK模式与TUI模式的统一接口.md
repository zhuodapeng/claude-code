# 10-3 SDK 模式与 TUI 模式的统一接口

## 本节要解决的问题

`queryLoop()` 只有一份代码，但它的两类使用者——SDK 调用者和 TUI——对"输出格式"的需求截然不同：

- **SDK 调用者**：需要干净的、可序列化的 `SDKMessage` 对象（`{ type: 'assistant', message: {...}, session_id: '...', uuid: '...' }`），不需要流式中间事件
- **TUI 用户**：需要 `stream_event`（每一个 `text_delta` 都要实时推送到屏幕），需要 `SpinnerMode` 更新，需要工具进度显示

**同一个 `query()` 函数是如何服务两类需求的？**

---

## 内部格式 vs 外部格式

`queryLoop()` yield 的是**内部 `Message` 类型**（以及 `stream_event`）——这些类型携带了 Claude Code 内部运作所需的所有字段：

```typescript
type AssistantMessage = {
  type: 'assistant'
  message: {
    role: 'assistant',
    content: ContentBlock[]  // 可能有多个 block
    stop_reason: string | null
    usage: { ... }
  }
  uuid: string
  error?: string
  // ... 更多内部字段
}
```

而 SDK 调用者看到的是 `SDKMessage`——一个更清晰的对外格式：

```typescript
type SDKAssistantMessage = {
  type: 'assistant'
  message: {
    role: 'assistant',
    content: ContentBlock | ContentBlock[]  // 单个 block 或多个
  }
  parent_tool_use_id: string | null  // 子 Agent 追踪
  session_id: string                  // 会话 ID
  uuid: string                        // 消息唯一 ID
  error?: string
}
```

---

## 消息格式化层：normalizeMessage()

**文件：[src/utils/queryHelpers.ts](../src/utils/queryHelpers.ts#L102-L221)**

`normalizeMessage()` 是 QueryEngine 里的"消息翻译器"——把内部 `Message` 转换成 SDK 调用者期望的 `SDKMessage`：

```typescript
export function* normalizeMessage(message: Message): Generator<SDKMessage> {
  switch (message.type) {
    case 'assistant':
      for (const _ of normalizeMessages([message])) {
        if (!isNotEmptyMessage(_)) continue  // 过滤空消息
        yield {
          type: 'assistant',
          message: _.message,
          parent_tool_use_id: null,
          session_id: getSessionId(),
          uuid: _.uuid,
          error: _.error,
        }
      }
      return
    case 'user':
      for (const _ of normalizeMessages([message])) {
        yield {
          type: 'user',
          message: _.message,
          parent_tool_use_id: null,
          session_id: getSessionId(),
          uuid: _.uuid,
          timestamp: _.timestamp,
          isSynthetic: _.isMeta || _.isVisibleInTranscriptOnly,
          tool_use_result: _.toolUseResult,
        }
      }
      return
    default:
      // 其他类型（stream_event 等）：不 yield 任何东西
  }
}
```

注意 `default` 分支是空的——对于 `stream_event`、`system` 等消息，`normalizeMessage()` 什么都不 yield。这些消息由 QueryEngine 的 `switch` 分支单独处理（或完全跳过）。

### normalizeMessages()：一个 block 拆成一个消息

`normalizeMessage()` 内部调用了 `normalizeMessages()`（注意是复数）。这个函数做了一件重要的事：**把一个含有多个 content block 的 AssistantMessage 拆分成多个"每个 block 一条"的消息**。

```
内部格式：
  AssistantMessage {
    content: [
      { type: 'thinking', thinking: '...' },
      { type: 'text', text: '分析结果...' }
    ]
  }

SDK 格式（拆分后）：
  SDKMessage { type: 'assistant', message: { content: thinking_block } }
  SDKMessage { type: 'assistant', message: { content: text_block } }
```

SDK 调用者不需要处理"一条消息里有多个 block"的复杂情况——每条 SDKMessage 只有一个 content block，更容易消费。

---

## 两种消费路径

### 路径一：SDK 模式（通过 QueryEngine）

```
queryLoop() yield Message/StreamEvent
    ↓
submitMessage() for-await loop
    ↓
switch (message.type) {
  case 'assistant': yield* normalizeMessage(message)  → SDKAssistantMessage
  case 'user':      yield* normalizeMessage(message)  → SDKUserMessage
  case 'stream_event': 
    if (includePartialMessages) yield stream_event    → 可选的流式事件
  case 'system': ...                                  → 部分转换（compact_boundary等）
  case 'attachment': ...                              → 部分转换（max_turns_reached等）
}
    ↓
SDK 调用者: for await (const msg of engine.submitMessage(...))
```

SDK 模式下，`stream_event` 默认**不输出**——SDK 调用者通常不需要看到每个 `text_delta`，他们只需要完整的消息。如果 SDK 调用者确实需要流式事件（比如要实时显示文字），可以设置 `includePartialMessages: true`。

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L818-L827)**

```typescript
case 'stream_event':
  // ...更新 token 统计...
  if (includePartialMessages) {
    yield {
      type: 'stream_event' as const,
      event: message.event,
      session_id: getSessionId(),
      parent_tool_use_id: null,
      uuid: randomUUID(),
    }
  }
  break
```

### 路径二：TUI 模式（直接调用 query()）

```
queryLoop() yield Message/StreamEvent
    ↓
ask() (REPL.tsx) for-await loop
    ↓
onQueryEvent(message)
    ↓
handleMessageFromStream(message, ...)
    ↓
switch (message.type) {
  stream_event: → React state 更新（spinner、streamingText）
  assistant:    → setMessages([...old, message])
  user:         → setMessages([...old, message])
  system:       → 处理各种系统消息（compact 等）
}
```

TUI 直接消费 queryLoop() 的原始输出，包括每一个 `stream_event`。`handleMessageFromStream()` 负责把这些事件分发到不同的 React state setter，驱动终端 UI 更新。

---

## stream_event 的处理差异

| | SDK 模式 | TUI 模式 |
|---|---|---|
| **是否消费 stream_event** | 默认不消费（`includePartialMessages=false`） | 全部消费 |
| **text_delta 的处理** | 等待完整 AssistantMessage | 实时更新 streamingText state |
| **spinner 更新** | 无（SDK 不渲染终端） | onSetStreamMode() |
| **工具参数预览** | 无 | onStreamingToolUses() |

这就是为什么 TUI 能实时显示"Claude 在打字"效果，而 SDK 模式只能在完整消息到来时才能处理——除非显式开启 `includePartialMessages`。

---

## SDKMessage 的完整类型族

SDK 调用者能收到的消息类型有：

```typescript
type SDKMessage =
  | SDKAssistantMessage    // Claude 的回复（含 text/tool_use/thinking）
  | SDKUserMessage         // 用户消息 / 工具结果
  | SDKUserMessageReplay   // --resume 时重放的历史用户消息
  | SDKSystemMessage       // 系统消息（system/init, compact_boundary 等）
  | SDKResultMessage       // 最终结果（success / error_max_turns / error_max_budget_usd...）
  | SDKCompactBoundaryMessage  // 上下文压缩边界
  | SDKToolUseSummaryMessage   // 工具执行摘要
  | SDKStreamEvent         // 流式事件（仅当 includePartialMessages=true）
  | SDKToolProgressMessage // 工具执行进度（Bash/PowerShell，长时间运行时）
```

最重要的是 `SDKResultMessage`——这是整个会话的"最终答案"，包含：

```typescript
type SDKResultMessage = {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | ...
  stop_reason: string | null    // queryLoop 的终止原因
  result: string                // Claude 的文本输出
  total_cost_usd: number        // 本次会话总费用
  usage: NonNullableUsage       // token 用量统计
  permission_denials: ...       // 被拒绝的工具列表
  duration_ms: number           // 耗时
  num_turns: number             // 总轮次
}
```

---

## 统一接口的设计取舍

**为什么不直接让 SDK 调用者使用 query()**，而是要包装一层 QueryEngine？

1. **格式隔离**：query() 的内部格式（`Message`）是复杂的、会随着功能演进而变化的内部类型。SDK 格式（`SDKMessage`）是稳定的、向后兼容的外部 API 格式。两者不能合并，因为任何对内部格式的修改都会成为 breaking change。

2. **状态管理**：SDK 调用者不需要管理 `mutableMessages`——让他们直接用 query() 意味着他们得自己处理消息历史，这是不必要的复杂性。

3. **附加功能**：QueryEngine 在 SDK 层面加了 token 统计、权限拒绝记录、transcript 持久化、USD 预算检查等——这些功能是"SDK 关心的"，而 TUI 通过 AppState 有自己的这套实现。

---

## 本节小结

- `queryLoop()` yield 内部 `Message` 类型（含 stream_event），一份代码服务两种模式
- SDK 模式经过 `normalizeMessage()` 转换：内部消息 → SDKMessage，多 block 消息拆分为多条
- TUI 模式直接消费原始输出，`handleMessageFromStream()` 将事件分发到 React state
- SDK 模式默认不 yield stream_event（等完整消息），可选 `includePartialMessages=true` 开启
- SDKResultMessage 是最终答案，包含 stop_reason、cost、usage 等元信息

## 前后呼应

- `handleMessageFromStream()` 的详细工作原理在 **[9-4 节](./9-4-text-delta事件Claude在打字.md)** 讲过
- `SDKResultMessage` 里的 `stop_reason` 对应 queryLoop() 的 `Terminal.reason`，在 **[9-8 节](./9-8-循环的终止条件.md)** 讲过

## 下一节预告

把本章所有内容串起来——一次完整的 submitMessage() 调用，从用户输入到最终 SDKResultMessage，经过哪些步骤？

➡️ [下一节：10-4 submitMessage() 的完整序列图](./10-4-submitMessage完整序列图.md)
