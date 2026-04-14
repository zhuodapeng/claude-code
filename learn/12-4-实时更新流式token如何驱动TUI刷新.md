# 12-4 实时更新：流式 token 如何驱动 TUI 刷新

> 每个 `text_delta` 事件就是一个字符增量，Claude 的回复以每秒几十个 token 的速度到来。本节追踪从 `text_delta` 到终端字符更新的完整路径：为什么是 `useState` 而不是 `useRef`，Ink 的 16ms 渲染节流如何防止界面过载，以及"streaming 文字 → 完整消息"的无缝切换是怎么实现的。

---

## 问题引入：每秒几十次更新，界面怎么不崩？

Claude 生成文字时，API 以 SSE 流的形式发送 `text_delta` 事件，速率可能达到每秒 50-100 个 token。

如果每个 token 都触发一次完整的 React reconciliation 和终端重绘，会怎样？

**问题一**：DOM diffing（Ink 的 yoga 布局计算）每次都要重算整个消息列表，代价高昂。

**问题二**：终端输出本来就有刷新率限制，频繁写入会导致闪烁和撕裂。

**朴素方案**：用 `useRef` 存 streaming 文字，定时轮询更新。

**问题**：轮询有固定的延迟，且需要额外的定时器管理。

**真实方案**：`useState` + Ink 内置的 16ms 渲染节流——每次 `text_delta` 都立即 `setState`，但 Ink 把同一帧内的所有更新合并成一次渲染。

---

## streaming 文字的存储

**文件：[src/screens/REPL.tsx](../src/screens/REPL.tsx#L1457-L1466)**

```typescript
// Streaming text display: set state directly per delta
// (Ink's 16ms render throttle batches rapid updates).
// Cleared on message arrival (messages.ts) so displayedMessages
// switches from deferredMessages to messages atomically.
const [streamingText, setStreamingText] = useState<string | null>(null)
```

这是一个 `useState`，不是 `useRef`。为什么？

`useRef` 的更新不触发 React 重渲染——如果用 ref，界面不会自动更新，你需要手动触发渲染。`useState` 则每次调用 setter 都告诉 React "有新内容，需要重渲染"。

关键在后半句注释：**Ink 的 16ms 渲染节流会批量处理这些快速更新**。不管 `setStreamingText` 被调用多少次，Ink 最快每 16ms（约 60fps）才真正重绘一次。所以"每个 token 都 setState"并不意味着"每个 token 都重绘"。

---

## text_delta 的完整路径

从 API 事件到界面刷新，调用链如下：

```
API SSE 流
  event: content_block_delta
    delta: { type: 'text_delta', text: '好的' }
        │
        ▼
query.ts 的 streamManager
  yield { type: 'stream_event', event: {...}, ttftMs: ... }
        │
        ▼
REPL.tsx 的 onQueryEvent()
  handleMessageFromStream(event, onMessage, onUpdateLength, ..., onStreamingText)
        │
        ▼
handleMessageFromStream() 的 text_delta 分支
  [src/utils/messages.ts#L3050-L3054]
  ┌──────────────────────────────────────────────────────────────┐
  │  case 'text_delta': {                                        │
  │    const deltaText = message.event.delta.text                │
  │    onUpdateLength(deltaText)        ← 更新 ref（不重渲染）   │
  │    onStreamingText?.(text =>        ← 触发 setState         │
  │      (text ?? '') + deltaText                                │
  │    )                                                         │
  │    return                                                     │
  │  }                                                           │
  └──────────────────────────────────────────────────────────────┘
        │
        ▼
setStreamingText(text => (text ?? '') + deltaText)
  ← React 的函数式更新器：用旧值计算新值
  ← React 将其加入更新队列
        │
        ▼
Ink 的 16ms 节流
  ← 多次 setState 在同一帧内合并
  ← 约每 16ms 真正执行一次 reconcile + 终端重绘
        │
        ▼
终端显示更新后的 streaming 文字
```

---

## 两个回调的分工：ref vs state

`handleMessageFromStream` 的签名里有两个关于"长度"的回调：

```typescript
// 回调2：更新响应长度（ref）
onUpdateLength: (newContent: string) => void,

// 回调7：更新 streaming 文字（state）
onStreamingText?: (f: (current: string | null) => string | null) => void,
```

对应 REPL.tsx 里的两个变量：

```typescript
// ref：不触发重渲染，供 spinner 动画读取
const responseLengthRef = useRef(0)
const setResponseLength = useCallback((f: (prev: number) => number) => {
  responseLengthRef.current = f(responseLengthRef.current)
  // 同时更新 API metrics（OTPS 计算用）
  if (responseLengthRef.current > prev) {
    const lastEntry = apiMetricsRef.current.at(-1)
    if (lastEntry) {
      lastEntry.lastTokenTime = Date.now()
      lastEntry.endResponseLength = responseLengthRef.current
    }
  }
}, [])

// state：触发重渲染，驱动 streaming 文字显示
const [streamingText, setStreamingText] = useState<string | null>(null)
```

注释解释了为什么 `responseLength` 用 ref：

> Ref instead of state to avoid triggering React re-renders on every streaming text_delta. The spinner reads this via its animation timer.
>
> *(用 ref 避免每次 text_delta 都触发 React 重渲染。spinner 通过它的动画定时器读取这个值。)*

Spinner 动画是每帧自己读 ref 更新，而不是被 React 驱动——这是一个刻意的性能优化。Spinner 的帧率（约 20fps）和 streaming 文字的更新率（受 Ink 16ms 节流）独立，互不影响。

---

## 只显示完整行：消除字符级闪烁

**文件：[src/screens/REPL.tsx](../src/screens/REPL.tsx#L1468-L1472)**

```typescript
// Hide the in-progress source line so text streams line-by-line, not
// char-by-char. lastIndexOf returns -1 when no newline, giving '' → null.
const visibleStreamingText = streamingText && showStreamingText
  ? streamingText.substring(0, streamingText.lastIndexOf('\n') + 1) || null
  : null
```

`streamingText` 包含**当前已收到的全部文字**（包括正在生成的那一行），但 `visibleStreamingText` 只显示到最后一个换行符。

举例：
```
streamingText = "你好！我来帮你解决这个问题。\n\n首先，我们需要"
                                            ^lastIndexOf('\n') 在这里

visibleStreamingText = "你好！我来帮你解决这个问题。\n\n"
                                            ↑ 截止到这里，"首先..." 这行被隐藏
```

效果：用户看到文字是**逐行出现**，而不是最后一行字符一个一个延伸。高速 streaming 时，逐行出现比逐字出现视觉上稳定得多。

`reducedMotion` 设置完全禁用 streaming 文字显示：

```typescript
const reducedMotion = useAppState(s => s.settings.prefersReducedMotion) ?? false
const showStreamingText = !reducedMotion && !hasCursorUpViewportYankBug()
```

`hasCursorUpViewportYankBug()` 是对某些终端（光标上移时有 bug）的兼容检测——这类终端也关闭 streaming 文字。

---

## useDeferredValue：保持输入响应

**文件：[src/screens/REPL.tsx](../src/screens/REPL.tsx#L1315-L1317)**

```typescript
// priority so the reconciler yields every 5ms, keeping input responsive
// while the expensive message processing pipeline runs.
const deferredMessages = useDeferredValue(messages)
```

`useDeferredValue` 是 React 18 的并发特性：把一个值标记为"低优先级"，让 React 优先处理高优先级更新（如用户输入），在空闲时才更新低优先级值。

在 streaming 期间：
- **高优先级**：用户的键盘输入、点击事件
- **低优先级**：消息列表的重新渲染（每次 append 都触发）

如果用 `messages` 直接渲染，每次 `setMessages` 都立刻触发昂贵的消息列表 reconcile，用户输入会卡顿。用 `deferredMessages`，React 可以把多次 `setMessages` 批量成一次大渲染，期间仍然响应用户输入。

但 streaming 文字显示时，需要**绕过** `useDeferredValue`：

```typescript
// Bypass useDeferredValue when streaming text is showing so Messages renders
// the final message in the same frame streaming text clears.
// Also bypass when not loading — after the turn ends, showing messages
// immediately prevents a jitter gap where spinner is gone but answer hasn't appeared.
const usesSyncMessages = showStreamingText || !isLoading
const displayedMessages = usesSyncMessages ? messages : deferredMessages
```

为什么 streaming 文字显示时要绕过？关键在"无缝切换"——下面详解。

---

## 关键切换：streaming 文字 → 完整消息

API 响应流的结束是这样的：

```
...多个 text_delta 事件...
content_block_stop 事件
message_delta 事件
message_stop 事件
↓
query.ts yield { type: 'assistant', message: { content: [{type: 'text', text: '...'}, ...] } }
```

`handleMessageFromStream` 收到完整的 `assistant` 消息时：

**文件：[src/utils/messages.ts](../src/utils/messages.ts#L2976-L2981)**

```typescript
// Clear streaming text NOW so the render can switch displayedMessages
// from deferredMessages to messages in the same batch,
// making the transition from streaming text → final message atomic (no gap, no duplication).
onStreamingText?.(() => null)    // ← 第一步：清除 streaming 文字
onMessage(message)               // ← 第二步：落地完整消息
```

这两行在同一个同步上下文里执行，React 会把它们批量成一次渲染：

```
同一个 React 批次
  setStreamingText(() => null)        → streamingText = null
  setMessages(prev => [...prev, msg]) → messages = [...prev, msg]
                                           ↑ usesSyncMessages = true（streaming 结束）
                                           ↑ displayedMessages = messages（绕过 deferred）
  ↓
一次渲染完成：streaming 文字消失 + 完整消息出现
```

如果这两步在不同的 React 批次里执行，会出现：
- 帧1：streaming 文字消失（但完整消息还没到）→ **空白闪烁**
- 帧2：完整消息出现

把它们放在同一个批次，就消除了这个中间帧。

---

## streaming 过程中的完整状态机

```
状态：streamingText = null
      messages = [...历史消息]
        │
        │ 用户提交输入
        ▼
状态：streamMode = 'requesting'（spinner 显示"请求中"）
        │
        │ message_start 事件（API 响应开始）
        ▼
状态：streamMode = 'thinking' 或 'responding'
        │
        │ 多个 text_delta 事件
        │ 每次：streamingText += deltaText（Ink 节流，约 60fps 更新）
        ▼
状态：streamingText = "你好！我来帮..."
      visibleStreamingText = 只显示完整行
        │
        │ message_stop 事件
        │ query.ts yield assistant 完整消息
        ▼
（同一 React 批次）
  streamingText = null          ← 清除
  messages = [..., assistantMsg] ← 追加
        │
        ▼
状态：streamingText = null
      messages = [...历史消息, assistantMsg]
      streaming 文字被完整消息替换，无闪烁
        │
        │ 如有工具调用：进入工具执行阶段
        ▼
状态：streamMode = 'tool-use'
```

---

## 本节小结

`text_delta` 通过 `setStreamingText(f)` 驱动实时更新，Ink 的 16ms 渲染节流保证不会每个 token 都重绘。`responseLengthRef` 用 ref（不触发重渲染）供 spinner 动画读取。`visibleStreamingText` 只显示完整行，避免逐字闪烁。`useDeferredValue` 在 streaming 期间把消息列表渲染降为低优先级，保持输入响应。streaming 文字清除和完整消息落地在同一 React 批次里完成，实现无缝切换。

## 前后呼应

- API SSE 流的解析（text_delta 事件的来源）在 **[9-3 节](./9-3-流式响应解析逐事件处理.md)** 有完整讲解
- `messages` 的 ref+state 双轨模式在 **[12-3 节](./12-3-消息流的渲染.md)** 讲了完整的 setMessages 包装器
- Ink 的渲染模型和终端限制在 **[4-2 节](./4-2-Ink用React渲染终端.md)** 有背景知识

## 下一节预告

第 12 章结束了。下一章转向上下文压缩（Auto Compact）——当对话历史积累到接近 context window 上限时，Claude Code 如何自动压缩，避免超出 token 限制。

➡️ [下一章：13-1 Token 窗口的上限与长会话问题](./13-1-Token窗口的上限与长会话问题.md)
