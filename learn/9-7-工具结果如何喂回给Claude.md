# 9-7 工具结果如何"喂回"给 Claude

## 本节要解决的问题

工具执行完了。Read 工具读了文件，Bash 工具跑了命令，它们都有了结果。现在需要把这些结果告诉 Claude，让 Claude 看到结果后继续回答。

工程问题：**结果用什么格式发送？追加到哪里？下一轮 API 调用的消息历史长什么样？**

---

## Anthropic 协议规定的消息结构

Anthropic API 的 tool_use 协议要求对话遵循这个格式：

```
用户: 请帮我读取 src/main.ts
Claude: [thinking text] 我来帮你读这个文件
        [tool_use: { id: 'toolu_01', name: 'Read', input: { file_path: 'src/main.ts' } }]
用户: [tool_result: { tool_use_id: 'toolu_01', content: '文件内容...' }]
Claude: 文件内容如下：... （基于读取结果的回答）
```

**工具结果必须以 `user` 角色发送**，包含 `tool_result` 类型的 content block，`tool_use_id` 与之前 Claude 发出的 `tool_use` block 的 `id` 精确匹配。

这是协议约束，不是设计选择——Anthropic API 就是这么定义的。这意味着整个对话在 API 层面呈现为"用户发工具结果 → Claude 回复 → 用户发工具结果 → Claude 回复..."的交替模式。

---

## toolResults 数组的积累

**文件：[src/query.ts](../src/query.ts#L552-L558)**

```typescript
const assistantMessages: AssistantMessage[] = []
const toolResults: (UserMessage | AttachmentMessage)[] = []
```

在流式 API 循环结束后，工具执行完成后，`toolResults` 里装的是：

```typescript
// UserMessage，其 content 是 tool_result blocks
{
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_01abc',
        content: '文件内容: ...',  // 或者 is_error: true, content: '错误信息'
      }
    ]
  }
}
```

`runTools()` 里的 `normalizeMessagesForAPI()` 负责把内部的 `Message` 格式转成 API 期望的 `MessageParam` 格式（包含 `tool_result` blocks）。

---

## 附件消息：额外的"喂入"

除了工具结果，`queryLoop()` 还会在下一轮请求前注入**附件消息**：

**文件：[src/query.ts](../src/query.ts#L1580-L1613)**

```typescript
for await (const attachment of getAttachmentMessages(
  null,
  updatedToolUseContext,
  null,
  queuedCommandsSnapshot,
  [...messagesForQuery, ...assistantMessages, ...toolResults],
  querySource,
)) {
  yield attachment
  toolResults.push(attachment)  // ← 附件也加入 toolResults
}
```

`getAttachmentMessages()` 会检查并注入：

1. **排队命令**（`queuedCommandsSnapshot`）：用户在 Claude 回复过程中输入的新消息，或者异步任务完成通知
2. **记忆注入**（`pendingMemoryPrefetch`）：相关的 MEMORY.md 内容
3. **Skill 发现**（`pendingSkillPrefetch`）：新发现的 skill 定义

这些都以 `AttachmentMessage` 形式附加到 `toolResults`，在下一轮 API 调用里作为额外 user message 发送给 Claude。

---

## 下一轮状态的构建

**文件：[src/query.ts](../src/query.ts#L1714-L1727)**

```typescript
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  //         ↑ 已有历史      ↑ Claude 的回复    ↑ 工具结果 + 附件
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  pendingToolUseSummary: nextPendingToolUseSummary,
  maxOutputTokensOverride: undefined,
  stopHookActive,
  transition: { reason: 'next_turn' },
}
state = next
// while(true) 的顶部会用新 state 开始下一次迭代
```

**这是循环的关键**：下一轮的 `messages` = 所有历史 + Claude 的本轮回复 + 工具执行结果。这个消息历史被传给下一次 `callModel()`，让 Claude 能看到工具结果并基于它回答。

---

## 下一次 API 调用的消息格式

经过 `normalizeMessagesForAPI()` 转换后，发给 API 的消息序列长这样：

```
[
  { role: 'user',      content: '请帮我读取 src/main.ts' },
  { role: 'assistant', content: [
    { type: 'text', text: '我来帮你读这个文件' },
    { type: 'tool_use', id: 'toolu_01', name: 'Read', input: {...} }
  ]},
  { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_01', content: '文件内容...' }
  ]},
  // ← Claude 在这里继续生成
]
```

注意消息历史的 `role` 交替原则：`user → assistant → user → assistant → ...`。工具结果以 `user` 发送，满足这个交替约束。

---

## 工具摘要：异步生成，下一轮 yield

**文件：[src/query.ts](../src/query.ts#L1412-L1482)**

```typescript
// 工具执行完成后，异步生成摘要（不阻塞下一轮 API 调用）
if (config.gates.emitToolUseSummaries && toolUseBlocks.length > 0) {
  nextPendingToolUseSummary = generateToolUseSummary({
    tools: toolInfoForSummary,
    signal: ...,
  }).then(summary => {
    if (summary) return createToolUseSummaryMessage(summary, toolUseIds)
    return null
  }).catch(() => null)
}
```

工具执行摘要（用于 mobile UI 显示"Claude 读取了 3 个文件"）是**异步生成**的——调用 Haiku 模型生成简短摘要，这个操作在下一轮 API 调用的同时进行（隐藏在 5-30 秒的流式响应延迟中）。

在下一轮的迭代里，摘要 Promise 被 await：

```typescript
if (pendingToolUseSummary) {
  const summary = await pendingToolUseSummary
  if (summary) yield summary  // ← yield 给 SDK 调用者
}
```

---

## 完整的"一轮"示意图

```
==== 第 1 轮 ====
API 调用（发送用户消息）
    ↓
Claude 流式输出：
  text block: "让我来读取这两个文件"
  tool_use: Read("file1.ts")    → needsFollowUp = true
  tool_use: Read("file2.ts")    → toolUseBlocks = [Read1, Read2]
    ↓
runTools([Read1, Read2])
  → 并发执行（两个 Read 都是并发安全的）
  → Read1 result: "内容1..."
  → Read2 result: "内容2..."
    ↓
getAttachmentMessages()
  → 没有排队命令
  → 有 MEMORY.md 相关记忆 → 注入
    ↓
state.messages = [
  user: "请帮我读取...",
  assistant: [text, tool_use(Read1), tool_use(Read2)],
  user: [tool_result(Read1), tool_result(Read2)],
  attachment: [memory content]
]
continue → 开始第 2 轮

==== 第 2 轮 ====
API 调用（发送包含工具结果的消息历史）
    ↓
Claude 流式输出：
  text block: "根据这两个文件的内容，我发现..."
  → needsFollowUp = false
    ↓
stop hooks 执行
return { reason: 'completed' }
```

---

## 本节小结

- 工具结果以 `user` 角色、`tool_result` content type 发送，与对应的 `tool_use` 通过 `tool_use_id` 配对
- 下一轮的 `messages` = 历史 + Claude 本轮回复 + 工具结果 + 附件，构成完整的上下文
- 附件消息（排队命令、记忆注入、skill 发现）也追加到 `toolResults`，一起发给下一轮的 Claude
- 工具摘要异步生成（调用 Haiku），在下一轮流式响应期间隐藏，yield 给 SDK

## 前后呼应

- 附件注入机制（`AttachmentMessage`）在 **[8-2 节](./8-2-processUserInput消息预处理.md)** 有介绍
- 消息历史的累积模式（每轮 append）是 **[10-2 节](./10-2-消息历史的生命周期.md)** 的核心主题

## 下一节预告

循环什么时候结束？除了"Claude 说完了"，还有哪些终止条件？每种终止意味着什么？

➡️ [下一节：9-8 循环的终止条件](./9-8-循环的终止条件.md)
