# 9-2 调用 Anthropic API：queryModel() 函数做了什么

## 本节要解决的问题

`queryLoop()` 在每次迭代里调用 `deps.callModel()`，实际上就是 `queryModelWithStreaming()`，最终执行的是 `queryModel()`。

这个函数是整个系统里最复杂的单个函数之一，有 1500 行代码。它在调用 API 之前需要准备十几个参数、处理各种 feature flag 和 beta header，然后建立流式连接。

本节的问题是：**在 `anthropic.beta.messages.create({ stream: true })` 被调用之前，究竟发生了什么？**

**文件：[src/services/api/claude.ts](../src/services/api/claude.ts#L1017-L1779)**

---

## 调用链：谁调用谁

```
queryLoop()
  └─ deps.callModel()         ← deps = productionDeps()
       └─ queryModelWithStreaming()   src/services/api/claude.ts:752
            └─ withStreamingVCR()    ← VCR 录制/回放（测试用）
                 └─ queryModel()     src/services/api/claude.ts:1017
```

`withStreamingVCR` 是测试基础设施——在测试环境下可以录制/回放 API 响应，生产环境直接透传。实际的 API 调用逻辑在 `queryModel()` 里。

---

## 第一阶段：消息格式转换

**文件：[src/services/api/claude.ts](../src/services/api/claude.ts#L1060-L1400)**

在构建 API 请求之前，`queryModel()` 需要把内部的 `Message[]` 转换成 API 接受的 `MessageParam[]`。

```
内部格式 Message[]
    ↓ normalizeMessagesForAPI()
MessageParam[]（API 格式）
    ↓ addCacheBreakpoints()
带 cache_control 标记的 MessageParam[]
    ↓ prependUserContext()
最终 messagesForAPI（发送给 API）
```

`normalizeMessagesForAPI()` 做的事情包括：
- 把 `AttachmentMessage` 转换成 API 的 user message（`<system-reminder>` 内容）
- 把 tool 结果格式化为 `tool_result` block
- 移除内部专用的字段

`addCacheBreakpoints()` 决定哪些消息要打 `cache_control` 标记：API 的消息历史缓存只能在最后几条消息上设置断点，超过一定数量会报错。系统用一个精心设计的算法，选择最近 N 条用户消息/工具结果的最后一个 block 打标记。

---

## 第二阶段：工具 Schema 构建

**文件：[src/services/api/claude.ts](../src/services/api/claude.ts#L1228-L1260)**

```typescript
const toolSchemas = await Promise.all(
  filteredTools.map(tool =>
    toolToAPISchema(tool, {
      getToolPermissionContext: options.getToolPermissionContext,
      tools,
      agents: options.agents,
      model: options.model,
      deferLoading: willDefer(tool),
    }),
  ),
)
```

每个工具都要通过 `toolToAPISchema()` 转换成 API 接受的 JSON Schema 格式。对于被 ToolSearch 延迟加载的工具（`willDefer(tool) = true`），转换后的 schema 会包含 `defer_loading: true` 字段——API 收到这个标记会跳过对该工具的 schema 校验，允许 Claude 通过 `tool_reference` block 来调用它。

**ToolSearch 筛选逻辑：**
```typescript
if (useToolSearch) {
  filteredTools = tools.filter(tool => {
    if (!deferredToolNames.has(tool.name)) return true    // 非延迟工具：包含
    if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) return true  // ToolSearch 自己：包含
    return discoveredToolNames.has(tool.name)  // 延迟工具：只包含已发现的
  })
}
```

这实现了 **ToolSearch 的懒发现机制**：Claude 通过 ToolSearch 找到某个工具后，该工具的名字被记录在 `discoveredToolNames` 里，下一次请求才会把它的 schema 带上。

---

## 第三阶段：系统提示词构建（上节讲过的）

**文件：[src/services/api/claude.ts](../src/services/api/claude.ts#L1358-L1379)**

```typescript
systemPrompt = asSystemPrompt([
  getAttributionHeader(fingerprint),
  getCLISyspromptPrefix({ ... }),
  ...systemPrompt,
  ...
].filter(Boolean))

const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
  skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
})
```

这是上一章（8-3）讲过的内容。注意这里的 `system` 变量是最终的 `TextBlockParam[]`，带有 `cache_control`。

---

## 第四阶段：paramsFromContext —— 动态参数构建器

**文件：[src/services/api/claude.ts](../src/services/api/claude.ts#L1538-L1729)**

`paramsFromContext` 是一个函数（不是对象），它接受一个 `RetryContext` 参数，返回完整的 API 请求参数。

**为什么是函数，不是对象？**

因为它需要在重试时根据 context 动态调整参数：
- 重试时可能需要降低 `max_tokens`（如果上次超出了）
- 重试时可能换了模型（fallback）
- 某些 beta header 需要根据重试状态动态附加

```typescript
const paramsFromContext = (retryContext: RetryContext) => {
  const betasParams = [...betas]
  
  // Sonnet 1M 实验：动态追加 beta header
  if (getSonnet1mExpTreatmentEnabled(retryContext.model)) {
    betasParams.push(CONTEXT_1M_BETA_HEADER)
  }
  
  // 输出 token 限制
  const maxOutputTokens =
    retryContext?.maxTokensOverride ||
    options.maxOutputTokensOverride ||
    getMaxOutputTokensForModel(options.model)
  
  // thinking 配置
  let thinking: ...
  if (modelSupportsThinking(options.model)) {
    if (modelSupportsAdaptiveThinking(...)) {
      thinking = { type: 'adaptive' }
    } else {
      thinking = { budget_tokens: ..., type: 'enabled' }
    }
  }
  
  // effort 配置（/effort 命令）
  const effort = resolveAppliedEffort(options.model, options.effortValue)
  configureEffortParams(effort, outputConfig, extraBodyParams, betasParams, ...)
  
  return {
    model: normalizeModelStringForAPI(options.model),
    messages: addCacheBreakpoints(messagesForAPI, ...),
    system,
    tools: allTools,
    max_tokens: maxOutputTokens,
    thinking,
    ...(speed !== undefined && { speed }),  // fast mode
    ...extraBodyParams,
  }
}
```

关键参数：

| 参数 | 来源 | 作用 |
|------|------|------|
| `model` | options.model，规范化 | 使用哪个 Claude 模型 |
| `messages` | 转换后的消息历史 + cache breakpoints | 对话上下文 |
| `system` | buildSystemPromptBlocks() | system prompt 块 |
| `tools` | toolSchemas + extraToolSchemas | 工具定义列表 |
| `max_tokens` | 模型上限或用户覆盖 | 最大输出 token 数 |
| `thinking` | adaptive 或 budget_tokens | 扩展思考配置 |
| `speed` | isFastMode → 'fast' | Fast 模式 |
| `betas` | 动态组装的 beta header 列表 | 启用实验特性 |

---

## 第五阶段：withRetry + 实际 API 调用

**文件：[src/services/api/claude.ts](../src/services/api/claude.ts#L1776-L1857)**

```typescript
const generator = withRetry(
  () => getAnthropicClient({ maxRetries: 0, model, fetchOverride, source }),
  async (anthropic, attempt, context) => {
    const params = paramsFromContext(context)
    
    // 核心调用：使用原始流而不是 BetaMessageStream
    const result = await anthropic.beta.messages
      .create(
        { ...params, stream: true },
        { signal }
      )
      .withResponse()
    
    streamRequestId = result.request_id
    return result.data  // Stream<BetaRawMessageStreamEvent>
  },
  { model, fallbackModel, thinkingConfig, signal, ... }
)
```

**`withRetry`** 是 Claude Code 自己实现的重试逻辑（不是 SDK 的内置重试）。它处理：
- 529 状态码（过载）：指数退避重试
- 认证错误：重新获取 API key 后重试
- Fallback 触发：切换到 fallback 模型重试

**为什么用 `anthropic.beta.messages.create({ stream: true })` 而不是 `stream()`？**

注意代码注释里说的：

```typescript
// Use raw stream instead of BetaMessageStream to avoid O(n²) partial JSON parsing
// BetaMessageStream calls partialParse() on every input_json_delta, which we don't need
// since we handle tool input accumulation ourselves
```

SDK 的 `BetaMessageStream` 会对每个 `input_json_delta` 事件做部分 JSON 解析，目的是提供实时的 "partial tool input"。但 Claude Code 不需要这个特性（工具 schema 在接收到 `content_block_stop` 后才执行），而对于有大量工具输入的情况（比如写一大段代码），这会变成 O(n²) 的操作，显著减慢流式响应。所以改用原始的 `Stream<BetaRawMessageStreamEvent>`，自己处理事件。

**`.withResponse()`** 的作用是同时获取响应对象（带有 HTTP headers），这样可以提取 `request_id`（API 请求追踪 ID）和 `Response`（用于后续清理）。

---

## 第六阶段：流空闲超时 watchdog

**文件：[src/services/api/claude.ts](../src/services/api/claude.ts#L1869-L1928)**

建立流式连接后，在进入 `for await (const part of stream)` 循环之前，启动了一个"空闲超时"监视器：

```typescript
const STREAM_IDLE_TIMEOUT_MS = parseInt(...) || 90_000  // 默认 90 秒
let streamIdleAborted = false

function resetStreamIdleTimer() {
  clearTimeout(streamIdleTimer)
  streamIdleTimer = setTimeout(() => {
    streamIdleAborted = true
    releaseStreamResources()  // 释放底层 TLS/socket 资源
  }, STREAM_IDLE_TIMEOUT_MS)
}
resetStreamIdleTimer()  // 启动
```

每收到一个 chunk，重置这个计时器：

```typescript
for await (const part of stream) {
  resetStreamIdleTimer()  // 每个事件都重置
  // ...处理事件...
}
```

**为什么需要这个 watchdog？**

SDK 的 `timeout` 参数只覆盖**初始连接**（发出 HTTP 请求到收到响应头）。一旦流式连接建立，如果服务器悄悄断开（比如网络问题、代理超时），`for await` 循环会**永久挂起**——它在等待永远不会到来的下一个事件。

注释里说这是个真实遇到的问题：

```typescript
// Unlike the stall detection below (which only fires when the *next* chunk arrives),
// this uses setTimeout to actively kill hung streams. Without this, a silently dropped
// connection can hang the session indefinitely since the SDK's request timeout only
// covers the initial fetch(), not the streaming body.
```

`STREAM_IDLE_TIMEOUT_MS` 默认 90 秒。超时后，watchdog 调用 `releaseStreamResources()` 释放底层 TLS 缓冲区（V8 堆外内存），然后抛出错误触发 non-streaming fallback 重试。

---

## 完整流程图

```
queryModelWithStreaming()
    │
    └─ queryModel(messages, systemPrompt, thinkingConfig, tools, signal, options)
              │
              ├─ [消息转换] normalizeMessagesForAPI() → messagesForAPI
              │
              ├─ [工具筛选] ToolSearch 筛选 → filteredTools
              │
              ├─ [工具 Schema] toolToAPISchema() * n → toolSchemas
              │
              ├─ [系统提示] buildSystemPromptBlocks() → system[]
              │
              ├─ [参数构建] paramsFromContext = (retryContext) => {...}
              │
              ├─ [重试器] withRetry(getClient, async (anthropic, attempt, ctx) => {
              │    params = paramsFromContext(ctx)
              │    stream = await anthropic.beta.messages.create({...stream:true}).withResponse()
              │    return stream.data
              │  })
              │
              ├─ [Watchdog 启动] resetStreamIdleTimer() 90s 超时
              │
              └─ for await (const part of stream) {
                   resetStreamIdleTimer()     ← 每个 chunk 重置
                   switch (part.type) {
                     case 'message_start': ...
                     case 'content_block_start': ...
                     case 'content_block_delta': ...  ← 文字/工具输入累积
                     case 'content_block_stop': ...   ← yield AssistantMessage
                     case 'message_delta': ...        ← usage、stop_reason
                     case 'message_stop': ...
                   }
                   yield { type: 'stream_event', event: part }  ← 每个事件都 yield
                 }
```

---

## 本节小结

- `queryModel()` 在 API 调用前要做大量准备：消息格式转换、工具筛选与 schema 构建、系统提示构建、动态参数组装
- 用原始 `Stream<BetaRawMessageStreamEvent>` 而非 SDK 的 `BetaMessageStream`，避免 O(n²) 的 JSON 解析开销
- `paramsFromContext` 是函数形式，支持重试时动态调整参数（换模型、调整 token 上限）
- 流空闲超时 watchdog（90s）保护系统不因静默网络故障而永久挂起
- 每个流式事件都会被 yield 出去（`stream_event` 类型），同时在函数内部累积为完整的 `AssistantMessage`

## 前后呼应

- 本节的工具筛选（ToolSearch deferred loading）在 **[7-7 节](./7-7-ToolSearch懒加载机制.md)** 有完整讲解
- 本节的 system prompt 构建（`buildSystemPromptBlocks`）在 **[8-3 节](./8-3-System-Prompt的构建.md)** 已详细讲过
- 本节的 `withRetry` 错误处理是后续 **[9-8 节](./9-8-循环的终止条件.md)** 讨论终止条件的基础

## 下一节预告

API 调用已经建立了流式连接，`for await (const part of stream)` 开始了。这些流式事件是什么形状？怎么被处理？

➡️ [下一节：9-3 流式响应解析](./9-3-流式响应解析逐事件处理.md)
