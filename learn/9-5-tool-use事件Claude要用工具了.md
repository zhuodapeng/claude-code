# 9-5 tool_use 事件：Claude 要用工具了

## 本节要解决的问题

Claude 在流式响应中发出了工具调用请求。这个信号是如何从 API 事件变成"需要执行工具"的决策的？

这里有个微妙的问题：`queryLoop()` 是如何知道"这次响应包含工具调用，需要继续循环"的？

---

## 信号：needsFollowUp 布尔值

**文件：[src/query.ts](../src/query.ts#L557-L835)**

在流式响应的处理循环里，`queryLoop()` 维护了一个标志：

```typescript
let toolUseBlocks: ToolUseBlock[] = []
let needsFollowUp = false

for await (const message of deps.callModel(...)) {
  // ...
  if (message.type === 'assistant') {
    assistantMessages.push(message)
    
    const msgToolUseBlocks = message.message.content.filter(
      content => content.type === 'tool_use',
    ) as ToolUseBlock[]
    
    if (msgToolUseBlocks.length > 0) {
      toolUseBlocks.push(...msgToolUseBlocks)
      needsFollowUp = true  // ← 这里设置为 true
    }
  }
}

// 流式循环结束后：
if (!needsFollowUp) {
  // → 进入"无工具调用"路径：stop hooks、然后 return
}
// needsFollowUp = true → 继续执行工具
```

**为什么用 `needsFollowUp` 而不检查 `stop_reason === 'tool_use'`？**

代码注释里说了：

```typescript
// Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly.
// Set during streaming whenever a tool_use block arrives — the sole
// loop-exit signal.
```

`stop_reason` 是在 `message_delta` 里才到达的，而且在某些情况下可能不准确。更可靠的方式是直接检查内容里是否有 `tool_use` block。这是防御性编程：不依赖一个"可能不可靠"的字段，而是依赖实际的内容结构。

---

## tool_use block 的结构

当 `content_block_stop` 到来，且 block 是 `tool_use` 类型时，构建出的 `AssistantMessage` 的内容里会有：

```typescript
{
  type: 'tool_use',
  id: 'toolu_01abc...',  // 工具调用的唯一 ID
  name: 'Read',          // 工具名称
  input: {               // 已解析的参数（不再是字符串）
    file_path: 'src/main.ts'
  }
}
```

注意 `input` 在这里已经是**解析好的对象**——`normalizeContentFromAPI()` 在 `content_block_stop` 时做了 `JSON.parse()`。

---

## StreamingToolExecutor：并行工具执行的优化

**文件：[src/query.ts](../src/query.ts#L560-L569)**

`queryLoop()` 里有一个特性：**流式工具执行**。

```typescript
const useStreamingToolExecution = config.gates.streamingToolExecution
let streamingToolExecutor = useStreamingToolExecution
  ? new StreamingToolExecutor(
      toolUseContext.options.tools,
      canUseTool,
      toolUseContext,
    )
  : null
```

普通路径（`streamingToolExecutor = null`）：等 Claude 完全停止输出后，再执行所有工具。

流式路径（`streamingToolExecutor != null`）：一旦 `content_block_stop` 产生了 tool_use block，立即开始执行它——不等待后续的文本块或其他工具块。

**为什么有两条路径？**

Claude 在一次响应里可能调用多个工具，比如：

```
[text block: "让我先读几个文件"]
[tool_use: Read("file1.ts")]
[tool_use: Read("file2.ts")]
[tool_use: Read("file3.ts")]
```

普通路径：等三个 tool_use block 都到了，然后并发执行三个 Read。
流式路径：`Read("file1.ts")` 刚 arrive 就开始执行，`Read("file2.ts")` 到的时候 `file1` 可能已经读完了。

对于读文件、执行 bash 等操作，流式执行可以节省几百毫秒——特别是有多个工具调用时效果显著。

---

## 流式执行期间的结果收集

**文件：[src/query.ts](../src/query.ts#L837-L862)**

```typescript
if (
  streamingToolExecutor &&
  !toolUseContext.abortController.signal.aborted
) {
  for (const result of streamingToolExecutor.getCompletedResults()) {
    if (result.message) {
      yield result.message  // 工具结果立即 yield
      toolResults.push(
        ...normalizeMessagesForAPI([result.message], ...).filter(_ => _.type === 'user'),
      )
    }
  }
}
```

在 Claude 还在流式输出的同时，已经完成的工具结果会被 yield 出去——用户可以在 Claude 还没说完话的时候就看到工具执行结果。

---

## 工具结果与 tool_use ID 的配对

工具调用和工具结果之间通过 `tool_use_id` 配对：

```
Claude 发出：
  AssistantMessage { content: [{ type: 'tool_use', id: 'toolu_01abc', name: 'Read', input: {...} }] }

系统执行工具后构建：
  UserMessage { content: [{ type: 'tool_result', tool_use_id: 'toolu_01abc', content: '文件内容...' }] }
```

Anthropic API 要求：**每个 `tool_use` block 必须有一个对应的 `tool_result` block**，且必须在下一轮请求中一起发送。如果有未配对的 `tool_use`（比如执行中途被中断），系统会调用 `yieldMissingToolResultBlocks()` 生成占位的错误 `tool_result`。

---

## tool_use 触发的路径图

```
API stream → content_block_stop (tool_use)
    │
    ├─ queryModel() 构建 AssistantMessage { content: [{ type: 'tool_use', ... }] }
    │  yield AssistantMessage
    │
    └─ queryLoop() 接收到 AssistantMessage
       ├─ assistantMessages.push(message)
       ├─ toolUseBlocks.push(...msgToolUseBlocks)
       └─ needsFollowUp = true
    
    ... 等流式循环结束 ...
    
    needsFollowUp = true
    ↓
    （不进入终止检查）
    ↓
    执行工具（下一节详细讲）
```

---

## thinking block 的特殊处理

**文件：[src/query.ts](../src/query.ts#L157-L163)**（注释部分）

包含 thinking block 的响应有额外约束（代码里有段"规则注释"）：

```typescript
/**
 * The rules of thinking are lengthy and fortuitous...
 * 
 * 1. 包含 thinking block 的消息必须在 max_thinking_length > 0 的请求中
 * 2. thinking block 不能是 response 的最后一个 block
 * 3. thinking block 在整个 trajectory 中必须保留（不能从历史里删掉）
 */
```

如果系统发现回应里有 thinking block，但下一次请求没有 `max_thinking_length > 0`，API 会返回错误。Claude Code 通过 `thinkingClearLatched` 来处理这种情况：如果缓存时间超过 1 小时，就在请求参数里加上 `clear_context_thinking`，告诉服务器可以丢弃 thinking blocks。

---

## 本节小结

- `needsFollowUp` 是判断"是否需要继续工具循环"的信号，通过检查 content 中是否有 `tool_use` block 来设置，比 `stop_reason` 更可靠
- `StreamingToolExecutor` 允许在 Claude 还在流式输出时就开始执行工具，减少等待时间
- 每个 `tool_use` block 都有唯一的 `id`，必须和 `tool_result` 一对一配对
- `thinking` block 有特殊的保留约束，不能随意从历史里删掉

## 前后呼应

- 工具的具体执行过程（权限检查、调用、结果返回）在 **[7-4 节](./7-4-工具的执行call生命周期.md)** 和 **[7-5 节](./7-5-权限检查工具执行前的守门人.md)** 已详细讲过
- 下一节讲的是 `runTools()` 如何编排多个工具的执行

## 下一节预告

有了 `toolUseBlocks`，系统如何决定工具执行顺序？哪些可以并发，哪些必须串行？

➡️ [下一节：9-6 runTools() 工具执行编排](./9-6-runTools工具执行编排.md)
