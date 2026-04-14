# 9-4 text_delta 事件：Claude 在"打字"

## 本节要解决的问题

用户在终端里看到 Claude 的文字一个字一个字地出现，就像有人在打字。这个视觉效果背后的工程实现是什么？

这一节聚焦于 `text_delta` 事件从 API 到终端屏幕的完整传播路径。

---

## 信息流：从 API 到终端

```
Anthropic API
    ↓ (content_block_delta, type: text_delta)
queryModel() 中的 for await 循环
    ↓ yield { type: 'stream_event', event: part }
queryLoop() 中的 for await 循环
    ↓ yield message（透传，不处理 stream_event）
submitMessage() 中的 for await 循环
    ↓ yield message（透传到 SDK 调用者）
REPL.tsx 的 onQueryImpl → onQueryEvent
    ↓ handleMessageFromStream()
    ↓ onStreamingText: text => (text ?? '') + deltaText
    ↓ onUpdateLength: 更新字符计数
React state 更新 → 终端重渲染
```

重点是：**`stream_event` 在整个链路上几乎是完全透传的**。`queryLoop()` 收到 `stream_event` 就直接 yield，不做任何处理。实际的消费逻辑在最顶层的 TUI 组件里。

---

## handleMessageFromStream()：所有流事件的统一入口

**文件：[src/utils/messages.ts](../src/utils/messages.ts#L2930-L2948)**

这个函数是 TUI 消费流事件的统一入口，签名：

```typescript
export function handleMessageFromStream(
  message: Message | TombstoneMessage | StreamEvent | RequestStartEvent | ...,
  onMessage: (message: Message) => void,      // 完整消息到达时的回调
  onUpdateLength: (newContent: string) => void, // 字符计数更新
  onSetStreamMode: (mode: SpinnerMode) => void, // spinner 状态更新
  onStreamingToolUses: (f: ...) => void,         // 工具输入流
  onTombstone?: (message: Message) => void,
  onStreamingThinking?: (f: ...) => void,
  onApiMetrics?: (metrics: { ttftMs: number }) => void,
  onStreamingText?: (f: (current: string | null) => string | null) => void,
): void
```

对于 `text_delta` 事件：

**文件：[src/utils/messages.ts](../src/utils/messages.ts#L3049-L3054)**

```typescript
case 'text_delta': {
  const deltaText = message.event.delta.text
  onUpdateLength(deltaText)                      // 更新字符计数（用于进度显示）
  onStreamingText?.(text => (text ?? '') + deltaText)  // 追加到流式文本
  return
}
```

`onStreamingText` 是一个 React state setter 的函数式更新——`text => (text ?? '') + deltaText` 把新的文字片段追加到当前已有的流式文本上。

---

## SpinnerMode：spinner 状态机

**文件：[src/utils/messages.ts](../src/utils/messages.ts#L3001-L3047)**

`stream_event` 到来时，`handleMessageFromStream()` 会更新 spinner 的状态：

```typescript
case 'content_block_start':
  switch (message.event.content_block.type) {
    case 'thinking':
      onSetStreamMode('thinking')    // spinner: 思考中...
      return
    case 'text':
      onSetStreamMode('responding')  // spinner: 正在回复...
      return
    case 'tool_use':
      onSetStreamMode('tool-input')  // spinner: 准备工具...
      return
  }
```

当 `message_stop` 到来时：

```typescript
if (message.event.type === 'message_stop') {
  onSetStreamMode('tool-use')        // spinner: 执行工具...
  onStreamingToolUses(() => [])      // 清空流式工具输入
  return
}
```

当 `stream_request_start` 到来时：

```typescript
if (message.type === 'stream_request_start') {
  onSetStreamMode('requesting')      // spinner: 请求中...
  return
}
```

这个状态机驱动终端底部的 spinner 动画，让用户知道系统在做什么：

```
● Thinking...        ← 'thinking' 模式
● Responding         ← 'responding' 模式
◍ Using Read tool    ← 'tool-use' 模式
◌ Processing...      ← 'requesting' 模式
```

---

## 流式文本 vs 最终消息：原子切换

一个精妙的设计细节：在流式传输期间，屏幕上显示的是**流式文本状态**（`streamingText`）；当 `content_block_stop` 到来，触发了完整 `AssistantMessage` 的到来时，UI 必须**原子地**从"流式文本"切换到"最终消息"——不能有闪烁、重复或空隙。

**文件：[src/utils/messages.ts](../src/utils/messages.ts#L2976-L2981)**

```typescript
// Clear streaming text NOW so the render can switch displayedMessages
// from deferredMessages to messages in the same batch, making the
// transition from streaming text → final message atomic (no gap, no duplication).
onStreamingText?.(() => null)  // ← 在 onMessage 之前清空
onMessage(message)             // ← 然后添加最终消息
```

注释里明确解释了为什么要先清空 `streamingText`：这两个操作在同一个 React 更新批次里，确保渲染器不会先短暂显示空白（streamingText 已清空，message 还没到），也不会重复显示文字。

---

## 流式工具输入的 UI

当 Claude 在调用工具时，用户能看到工具参数实时形成：

**文件：[src/utils/messages.ts](../src/utils/messages.ts#L3056-L3073)**

```typescript
case 'input_json_delta': {
  const delta = message.event.delta.partial_json
  const index = message.event.index
  onUpdateLength(delta)
  onStreamingToolUses(_ => {
    const element = _.find(_ => _.index === index)
    if (!element) return _
    return [
      ..._.filter(_ => _ !== element),
      {
        ...element,
        unparsedToolInput: element.unparsedToolInput + delta,  // JSON 片段累积
      },
    ]
  })
  return
}
```

`onStreamingToolUses` 更新一个 React state——`StreamingToolUse[]`，TUI 会实时渲染这个 partial JSON，让用户看到 Claude 正在组装工具的参数。

---

## 从 stream_event 到 React state 的代码路径

**文件：[src/screens/REPL.tsx](../src/screens/REPL.tsx#L2583-L2660)**

在 `REPL.tsx` 里，`onQueryEvent` 调用 `handleMessageFromStream()`，把各个 UI 更新函数传进去：

```typescript
const onQueryEvent = useCallback((event: ...) => {
  handleMessageFromStream(
    event,
    newMessage => setMessages(old => [...old, newMessage]),  // onMessage
    newContent => onUpdateLength(newContent),                 // onUpdateLength
    mode => setSpinnerMode(mode),                            // onSetStreamMode
    f => setStreamingToolUses(f),                            // onStreamingToolUses
    tombstone => setMessages(old => old.filter(m => m !== tombstone)),  // onTombstone
    f => setStreamingThinking(f),                            // onStreamingThinking
    metrics => setApiMetrics(metrics),                        // onApiMetrics
    f => setStreamingText(f),                                 // onStreamingText
  )
}, [...])
```

这些 setter 都是标准的 React state setter。当 `text_delta` 到来时，`setStreamingText` 被调用，React 重新渲染 TUI，终端上出现新的文字。

由于 Ink（React 终端渲染器）的特性，React 的 state 更新是**批处理**的——多个快速到来的 `text_delta` 可能在一次 React 渲染中合并显示，避免每个字符都触发一次昂贵的终端重渲染。

---

## 本节小结

- `text_delta` 事件在整个链路上几乎是完全透传的，从 API 到 `queryModel`，再穿透 `queryLoop` 和 `submitMessage`，直到 REPL 的 `onQueryEvent`
- `handleMessageFromStream()` 是所有流事件的统一消费入口，把事件分发到不同的 React state setter
- `streamingText` 状态持有当前的流式文字，在 `content_block_stop` 时原子清空并替换为完整消息，确保无闪烁过渡
- `SpinnerMode` 状态机（`requesting/thinking/responding/tool-input/tool-use`）驱动终端底部的 spinner 动画
- 流式工具输入（`input_json_delta`）也实时渲染，让用户看到 Claude 组装工具参数的过程

## 前后呼应

- 本节消费的 `stream_event` 是在 **[9-3 节](./9-3-流式响应解析逐事件处理.md)** 中 yield 出来的
- 本节对应的 React 渲染细节（Ink TUI）见 **[4-2 节](./4-2-Ink用React渲染终端.md)**

## 下一节预告

当 `content_block_stop` 携带的是 `tool_use` block 时，`queryLoop` 是如何检测到并准备工具执行的？

➡️ [下一节：9-5 tool_use 事件：Claude 要用工具了](./9-5-tool-use事件Claude要用工具了.md)
