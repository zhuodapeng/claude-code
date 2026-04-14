# 13-3 压缩的实现：让 Claude 总结自己

## 问题引入：怎么让 Claude 总结一段它自己参与的对话？

Auto Compact 的核心操作听起来有点奇怪：**用同一个 Claude 模型，把它自己和用户的历史对话总结成一段文字**，然后用这段文字替换掉那些历史消息。

这里有几个工程挑战：
- 如何防止 Claude 在总结时"分心"去调工具？
- 如果历史消息本身就已经超过 context 上限，连总结请求都发不出去怎么办？
- 总结应该包含哪些内容，才能让后续对话不会"失忆"？

这一节我们从 [`compactConversation()`](../src/services/compact/compact.ts#L387) 开始，逐层展开。

---

## 整体流程一览

```
compactConversation(messages, context, ...)
│
├── executePreCompactHooks()          // 执行用户配置的 pre_compact hook
│
├── 预处理消息
│   ├── stripImagesFromMessages()     // 剥离图片，避免摘要请求超限
│   └── stripReinjectedAttachments()  // 剥离会在压缩后重新注入的附件
│
├── 构建 summary 请求
│   └── getCompactPrompt()            // NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT
│
├── for (;;) PTL 重试循环
│   └── streamCompactSummary()        // 实际调用 Claude 生成摘要
│       └── runForkedAgent()          // 派生一个独立的 Claude 实例
│
├── formatCompactSummary()            // 剥离 <analysis> 草稿块
│
├── 构建压缩后附件
│   ├── createPostCompactFileAttachments()  // 重新注入读过的文件
│   ├── getDeferredToolsDeltaAttachment()   // 重新声明工具
│   └── processSessionStartHooks()         // 执行 session_start hooks
│
└── 返回 CompactionResult
    ├── boundaryMarker          // 标记压缩边界的系统消息
    ├── summaryMessages         // 摘要内容（包裹在用户消息里）
    ├── attachments             // 重新注入的文件和工具附件
    └── hookResults             // session_start hook 输出
```

---

## 第一步：为什么要剥离图片？

**文件：[src/services/compact/compact.ts](../src/services/compact/compact.ts#L145-L200)**

```typescript
export function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    // 只处理 user 消息（assistant 消息不含图片）
    if (message.type !== 'user') return message

    const content = message.message.content
    if (!Array.isArray(content)) return message

    let hasMediaBlock = false
    const newContent = content.flatMap(block => {
      if (block.type === 'image') {
        hasMediaBlock = true
        return [{ type: 'text' as const, text: '[image]' }]  // 替换为文本占位符
      }
      // document 类型同样处理
      if (block.type === 'document') {
        hasMediaBlock = true
        return [{ type: 'text' as const, text: '[document]' }]
      }
      // tool_result 内部也可能嵌套图片
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        // 递归处理 tool_result 内容 ...
      }
      return [block]
    })
    // ...
  })
}
```

注释解释了原因："Images are not needed for generating a conversation summary and can cause the compaction API call itself to hit the prompt-too-long limit, especially in CCD sessions where users frequently attach images."

关键点：**图片 token 很贵**。一张截图可能消耗 1,000-5,000 token。如果用户附了 10 张图，这些图本身就是 token 爆炸的主要来源之一。而总结对话时，知道"某处共享了一张图"就够了——具体图片内容对摘要没有意义。

---

## 第二步：NO_TOOLS_PREAMBLE——禁止工具调用

Claude 默认会在觉得需要时调用工具。但在压缩操作里，这是灾难性的：
- 最大轮次是 1（maxTurns: 1），一次工具调用就会消耗掉这唯一的机会
- 工具调用结果需要再一轮才能得到文本输出，但 maxTurns=1 不允许

**文件：[src/services/compact/prompt.ts](../src/services/compact/prompt.ts#L19-L26)**

```typescript
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`
```

措辞刻意使用了"CRITICAL"、大写、破折号列表，还加了后果警告（"you will fail the task"）。这是因为：

在 Sonnet 4.6+ 这类使用 adaptive thinking 的模型上，即便没有工具调用需求，模型有时也会"尝试"工具调用，导致 2.79% 的失败率（注释里提到"0.01% on 4.5"）。强化警告把这个失败率降了下来。

---

## 第三步：BASE_COMPACT_PROMPT 的 9 个节

**文件：[src/services/compact/prompt.ts](../src/services/compact/prompt.ts#L61-L143)**

完整 prompt 要求 Claude 在 `<summary>` 块里输出这 9 节内容：

```
1. Primary Request and Intent    ← 用户真正想做什么
2. Key Technical Concepts        ← 涉及的技术概念
3. Files and Code Sections       ← 读了/改了哪些文件，完整代码片段
4. Errors and fixes              ← 遇到过的错误和修复方式
5. Problem Solving               ← 解决了什么问题，正在排查什么
6. All user messages             ← 所有用户消息（不含工具结果）
7. Pending Tasks                 ← 还没完成的任务
8. Current Work                  ← 压缩发生时正在做什么（最重要）
9. Optional Next Step            ← 压缩后应该继续做什么
```

节 6（"All user messages"）特别有趣——要求 Claude 把用户的每一条消息都抄录下来。这是为了让压缩后继续的 Claude 能准确理解"用户告诉我做了什么"，而不是依赖对话摘要的二手叙述。用户的反馈（"不，不要这样做"）尤其关键，如果摘要遗漏了，可能导致压缩后 Claude 重犯同样的错误。

另外，prompt 还要求先输出 `<analysis>` 块——这是一个"思考草稿"区域，用来整理思路、确保覆盖所有要点——**但最终不会被保存**。

---

## 第四步：<analysis> 草稿块被剥离

**文件：[src/services/compact/prompt.ts](../src/services/compact/prompt.ts#L311-L335)**

```typescript
export function formatCompactSummary(summary: string): string {
  let formattedSummary = summary

  // 剥离 <analysis> 块——它是提升摘要质量的草稿，
  // 一旦摘要写完就没有信息价值了
  formattedSummary = formattedSummary.replace(
    /<analysis>[\s\S]*?<\/analysis>/,
    '',
  )

  // 提取并格式化 <summary> 块
  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    const content = summaryMatch[1] || ''
    formattedSummary = formattedSummary.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    )
  }
  // ...
}
```

这是"链式思考 + 信息提纯"模式：让模型先自由思考（`<analysis>`），然后输出正式结论（`<summary>`），最后丢掉草稿只保留结论。

等价于人类写作时先打草稿、再写正文——草稿帮助你写好正文，但最终提交的是正文。

---

## 第五步：streamCompactSummary 与 runForkedAgent

**文件：[src/services/compact/compact.ts](../src/services/compact/compact.ts#L1136-L1188)**

`streamCompactSummary()` 的核心是调用 [`runForkedAgent()`](../src/utils/forkedAgent.ts)：

```typescript
const result = await runForkedAgent({
  promptMessages: [summaryRequest],   // 就是那个 9-节 prompt
  cacheSafeParams,                    // 允许复用主对话的 prompt cache
  canUseTool: createCompactCanUseTool(), // 拒绝所有工具调用
  querySource: 'compact',             // 这就是 shouldAutoCompact 里递归守卫检查的值
  forkLabel: 'compact',
  // ...
})
```

`querySource: 'compact'` 直接对应 `shouldAutoCompact()` 里的第一层守卫：

```typescript
if (querySource === 'session_memory' || querySource === 'compact') {
  return false  // 派生的压缩 Agent 不能再触发压缩
}
```

这形成了一个完整的防御链：主线程压缩时会启动一个 querySource='compact' 的子 Agent，这个子 Agent 在执行 query 时，`shouldAutoCompact()` 里的字符串检查会短路返回 false，确保不会嵌套触发。

---

## 第六步：PTL 重试——压缩请求本身超限怎么办？

这是 CC-1180 问题：如果会话历史太长，连摘要请求本身都会超过 context 上限（prompt_too_long）。

**文件：[src/services/compact/compact.ts](../src/services/compact/compact.ts#L450-L491)**

```typescript
let ptlAttempts = 0
for (;;) {
  summaryResponse = await streamCompactSummary({ messages: messagesToSummarize, ... })
  summary = getAssistantMessageText(summaryResponse)

  // 如果成功（没有 prompt_too_long 错误），跳出循环
  if (!summary?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) break

  // 压缩请求本身超限了——截断最老的 API 轮次组，然后重试
  ptlAttempts++
  const truncated =
    ptlAttempts <= MAX_PTL_RETRIES          // MAX_PTL_RETRIES = 3
      ? truncateHeadForPTLRetry(messagesToSummarize, summaryResponse)
      : null

  if (!truncated) {
    throw new Error(ERROR_MESSAGE_PROMPT_TOO_LONG)  // 实在不行，报错
  }

  messagesToSummarize = truncated  // 用截断后的消息重试
}
```

`truncateHeadForPTLRetry()` 会把最老的消息组（一个"API 轮次"包括用户消息 + 对应的助手回复 + 工具结果）删掉，直到删除的量够填补超限 token 数。这是有损操作，但至少解锁了用户——否则用户只能硬关进程。

---

## 第七步：压缩完成后，重新注入"记忆材料"

压缩后的消息历史是一张白纸（只有摘要），所以很多"运行时记忆"需要重新注入：

**文件：[src/services/compact/compact.ts](../src/services/compact/compact.ts#L532-L594)**

```typescript
// 重新注入读过的文件（最多 5 个，避免再次超限）
const [fileAttachments, asyncAgentAttachments] = await Promise.all([
  createPostCompactFileAttachments(
    preCompactReadFileState,    // 压缩前 Claude 读过的文件
    context,
    POST_COMPACT_MAX_FILES_TO_RESTORE,  // = 5
  ),
  createAsyncAgentAttachmentsIfNeeded(context),
])

// 重新声明工具（deferred tools、MCP 工具等）
for (const att of getDeferredToolsDeltaAttachment(
  context.options.tools,
  context.options.mainLoopModel,
  [],               // 空历史 = 全量声明
  { callSite: 'compact_full' },
)) {
  postCompactFileAttachments.push(createAttachmentMessage(att))
}

// 执行 session_start hooks（就像新会话开始一样）
const hookMessages = await processSessionStartHooks('compact', {
  model: context.options.mainLoopModel,
})
```

为什么要"重新注入读过的文件"？因为摘要里可能只有"读了 foo.ts"这样的描述，但 Claude 接下来可能需要再次修改它。把 5 个最近读过的文件内容直接附在摘要后面，相当于"帮 Claude 记住上下文的重要部分"，避免它立刻就需要重新 Read 文件。

---

## 本节小结

`compactConversation()` 的核心流程：剥离图片（避免超限）→ 构建禁止工具调用的 9 节 prompt → 用 `runForkedAgent()` 派生一个 Claude 实例生成摘要 → 剥离 `<analysis>` 草稿只保留摘要 → PTL 重试处理超限情况 → 重新注入文件/工具/hook 结果。整个流程是一个精心设计的"自我总结"管道，核心约束是 maxTurns=1 和 querySource='compact'（防止递归）。

## 前后呼应

- 本节提到的 `runForkedAgent()` 是 Claude Code 派生子 Agent 的通用机制，在 **[14 章 多 Agent 系统](./14-1-什么是多Agent系统.md)** 里会完整介绍。
- `querySource: 'compact'` 对应 **[13-2 节](./13-2-AutoCompact触发时机.md)** 里递归守卫的第一层检查，现在你看到了它是在哪里被设置进去的。

## 下一节预告

下一节我们看压缩后的"消息结构"——`CompactionResult` 里的五个字段各是什么，`buildPostCompactMessages()` 以什么顺序组装它们，以及 query.ts 是如何接收并处理这个结果的。

➡️ [下一节：13-4 压缩后的消息结构](./13-4-压缩后的消息结构.md)
