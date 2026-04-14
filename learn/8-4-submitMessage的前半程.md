# 8-4 QueryEngine.submitMessage() 的前半程

## 本节要解决的问题

前几节分别拆解了"用户输入如何变成消息"（8-1/8-2）和"System Prompt 如何被转换"（8-3）。但它们是分散的——真正把这些串联起来的是 `QueryEngine.submitMessage()`。

`submitMessage()` 是整个请求生命周期的**总编排者**。它接受用户的 prompt，做一系列准备工作，然后把控制权交给 `query()` 循环。这一节专门讲"交给 `query()` 之前发生了什么"——也就是前半程的 12 个关键步骤。

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L209-L686)**

---

## 总览：12 个步骤

先看完整流程图，然后逐步拆解：

```
submitMessage(prompt) 被调用
         ↓
Step 1: 封装 canUseTool（权限拒绝追踪）
         ↓
Step 2: 解析模型和思考配置
         ↓
Step 3: fetchSystemPromptParts() — 获取 System Prompt 三件套
         ↓
Step 4: 拼装最终 systemPrompt
         ↓
Step 5: 构建 processUserInputContext（大型上下文对象）
         ↓
Step 6: 处理孤立权限（orphanedPermission）
         ↓
Step 7: processUserInput() — 处理用户输入
         ↓
Step 8: 推入消息历史
         ↓
Step 9: 持久化 transcript（先于 API 调用！）
         ↓
Step 10: 加载 skills + plugins
         ↓
Step 11: yield buildSystemInitMessage()（SDK 的第一条消息）
         ↓
Step 12: 判断 shouldQuery
    ├─ false → 返回本地命令结果，直接 return
    └─ true  → 进入 query() 循环
```

---

## Step 1：封装 canUseTool，追踪权限拒绝

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L244-L271)**

```typescript
const wrappedCanUseTool: CanUseToolFn = async (
  tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision,
) => {
  const result = await canUseTool(
    tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision,
  )
  // Track denials for SDK reporting
  if (result.behavior !== 'allow') {
    this.permissionDenials.push({
      tool_name: sdkCompatToolName(tool.name),
      tool_use_id: toolUseID,
      tool_input: input,
    })
  }
  return result
}
```

为什么要包一层？

`canUseTool` 是从外部注入的（依赖倒置）。在 TUI 模式，它是弹出权限对话框的 React hook；在 SDK 模式，它是程序化的权限判断函数。`QueryEngine` 不关心是哪种实现，只需要记录"哪些工具被拒绝了"——这个信息会附加到最终的 result 消息里，SDK 调用者可以用来审计权限决策。

`sdkCompatToolName()` 把内部工具名 `Agent` 转译成旧 SDK 期望的 `Task`——这是向后兼容的迁移代码。

---

## Step 2：解析模型和思考配置

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L273-L283)**

```typescript
const initialMainLoopModel = userSpecifiedModel
  ? parseUserSpecifiedModel(userSpecifiedModel)
  : getMainLoopModel()

const initialThinkingConfig: ThinkingConfig = thinkingConfig
  ? thinkingConfig
  : shouldEnableThinkingByDefault() !== false
    ? { type: 'adaptive' }
    : { type: 'disabled' }
```

`getMainLoopModel()` 从配置读取默认模型。`parseUserSpecifiedModel()` 处理用户通过 `/model` 命令或 `--model` 参数指定的模型名。

ThinkingConfig 默认是 `{ type: 'adaptive' }`——Claude 根据任务复杂度自己决定是否开启 extended thinking。只有明确配置 `{ type: 'disabled' }` 或 `shouldEnableThinkingByDefault()` 返回 false 时才禁用。

注意这里都是 `initial` 前缀——模型和思考配置在后续 `/model` 等 slash command 处理后可能会更新。

---

## Step 3：fetchSystemPromptParts() — 三件套

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L284-L308)**

```typescript
headlessProfilerCheckpoint('before_getSystemPrompt')
const {
  defaultSystemPrompt,
  userContext: baseUserContext,
  systemContext,
} = await fetchSystemPromptParts({
  tools,
  mainLoopModel: initialMainLoopModel,
  additionalWorkingDirectories: ...,
  mcpClients,
  customSystemPrompt: customPrompt,
})
headlessProfilerCheckpoint('after_getSystemPrompt')
```

`fetchSystemPromptParts()` 并行调用三个函数，返回三件套：

| 字段 | 来源 | 用途 |
|------|------|------|
| `defaultSystemPrompt` | `getSystemPrompt()` | 系统指令的主体内容（string[]） |
| `userContext` | `getUserContext()` | 注入 `<system-reminder>` 的键值对（当前日期等） |
| `systemContext` | `getSystemContext()` | 注入 `prependUserContext()` 的键值对（环境信息） |

**关键判断**：如果 `customSystemPrompt` 存在（SDK 调用者自定义了 system prompt），则 `defaultSystemPrompt` 为空数组，`systemContext` 也为空——完全用调用者提供的替代。

`headlessProfilerCheckpoint` 是性能分析埋点，用于测量各阶段耗时，不影响逻辑。

---

## Step 4：拼装最终 systemPrompt

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L302-L325)**

```typescript
const userContext = {
  ...baseUserContext,
  ...getCoordinatorUserContext(
    mcpClients,
    isScratchpadEnabled() ? getScratchpadDir() : undefined,
  ),
}

// SDK 调用者自定义 prompt 且配置了 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 时，
// 注入 memory mechanics prompt
const memoryMechanicsPrompt =
  customPrompt !== undefined && hasAutoMemPathOverride()
    ? await loadMemoryPrompt()
    : null

const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

这里组装了最终的 `systemPrompt`（一个 branded `string[]`）：

```
[
  customPrompt 或 defaultSystemPrompt 的展开内容,  // 主体
  memoryMechanicsPrompt（可选）,                    // 记忆机制说明（SDK 专用）
  appendSystemPrompt（可选）,                       // 附加内容（SDK 调用者追加的）
]
```

`asSystemPrompt()` 只是类型转换——把普通 `string[]` 打上 brand 标记，防止误传未处理的 string[]。

注意这里的 `systemPrompt` 还不包含 attribution header 和 CLI prefix——那两个是在 `claude.ts`（API 调用层）才加的，因为它们属于 API 协议层面的内容，不应该污染上层的逻辑 system prompt。

---

## Step 5：构建 processUserInputContext

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L335-L395)**

这是代码里最大的一个对象字面量，大约 60 行。它是 `processUserInput()` 的"执行上下文"——包含所有 slash command、工具调用、状态更新需要的回调和配置。

关键字段：

```typescript
let processUserInputContext: ProcessUserInputContext = {
  messages: this.mutableMessages,        // 消息历史（引用，可变）
  setMessages: fn => {                   // slash command 用来修改消息历史
    this.mutableMessages = fn(this.mutableMessages)
  },
  onChangeAPIKey: () => {},              // API key 变更回调（SDK 模式不需要）
  handleElicitation: ...,                // 工具调用时的 elicitation 处理
  options: {
    commands,                            // 注册的命令列表
    tools,                               // 注册的工具列表
    verbose,                             // 是否 verbose 模式
    mainLoopModel: initialMainLoopModel, // 当前模型
    thinkingConfig: initialThinkingConfig,
    mcpClients,
    isNonInteractiveSession: true,       // SDK 模式 = 非交互
    customSystemPrompt,
    appendSystemPrompt,
    ...
  },
  getAppState,                           // 获取 AppState 的函数
  setAppState,                           // 更新 AppState 的函数
  abortController: this.abortController, // 中止控制器
  readFileState: this.readFileState,     // 文件读取状态缓存
  nestedMemoryAttachmentTriggers: new Set<string>(),  // 嵌套记忆触发器
  discoveredSkillNames: this.discoveredSkillNames,    // 已发现的 skill 名称
  updateFileHistoryState: ...,           // 文件历史状态更新器
  setSDKStatus,                          // SDK 状态更新器
}
```

为什么这么大？因为 Claude Code 的 slash command 系统非常强大——`/model`、`/tools`、`/compact` 等命令可以改变模型、工具列表、压缩消息历史……每种操作都需要对应的回调接口。这个 context 对象是命令系统和引擎之间的"服务总线"。

**SDK 模式的特殊标记**：注意 `isNonInteractiveSession: true`——这告诉下游代码"不要尝试显示 UI 对话框"。

---

## Step 6：处理孤立权限（Orphaned Permission）

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L397-L408)**

```typescript
if (orphanedPermission && !this.hasHandledOrphanedPermission) {
  this.hasHandledOrphanedPermission = true
  for await (const message of handleOrphanedPermission(
    orphanedPermission,
    tools,
    this.mutableMessages,
    processUserInputContext,
  )) {
    yield message
  }
}
```

什么是"孤立权限"？这是一个边缘场景：SDK 调用者在上一轮等待权限确认时，Claude Code 进程崩溃或被重启。重启后，那个等待中的权限请求成了"孤儿"——没有对应的工具执行在进行中，但系统里还记录着这个未完成的权限请求。

`handleOrphanedPermission` 负责重新处理这个挂起的权限：要么让调用者重新决定，要么以拒绝的方式结束它，让对话可以继续。

这个字段的存在说明 Claude Code 必须能容忍**进程重启后的状态恢复**——这是生产系统的必要特性。

---

## Step 7：processUserInput() — 处理用户输入

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L410-L428)**

```typescript
const {
  messages: messagesFromUserInput,
  shouldQuery,
  allowedTools,
  model: modelFromUserInput,
  resultText,
} = await processUserInput({
  input: prompt,
  mode: 'prompt',
  setToolJSX: () => {},
  context: {
    ...processUserInputContext,
    messages: this.mutableMessages,
  },
  messages: this.mutableMessages,
  uuid: options?.uuid,
  isMeta: options?.isMeta,
  querySource: 'sdk',
})
```

这就是在 8-2 节讲过的 `processUserInput()`：

- 如果 `prompt` 是 `/compact` 之类的 slash command → `shouldQuery = false`，`resultText` 包含本地结果
- 如果是普通文本 → `shouldQuery = true`，`messagesFromUserInput` 包含 `[UserMessage, ...attachmentMessages]`

`modelFromUserInput` 是 null（普通输入）或者 slash command 更新后的模型名（`/model claude-opus-4` 会返回新模型）。

---

## Step 8：推入消息历史

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L430-L434)**

```typescript
// Push new messages, including user input and any attachments
this.mutableMessages.push(...messagesFromUserInput)

// Update params to reflect updates from processing /slash commands
const messages = [...this.mutableMessages]
```

把 `processUserInput()` 返回的所有消息（用户消息 + 附件消息）推入 `this.mutableMessages`。

`const messages = [...this.mutableMessages]` 做了一次浅拷贝，是为了给后续的 `query()` 循环传入一个**快照**——避免 `query()` 内部对消息数组的修改影响到 `mutableMessages`。

---

## Step 9：持久化 transcript（先于 API 调用！）

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L436-L463)**

这是一个重要的设计决策，代码注释里有详细说明：

```typescript
// Persist the user's message(s) to transcript BEFORE entering the query
// loop. The for-await below only calls recordTranscript when ask() yields
// an assistant/user/compact_boundary message — which doesn't happen until
// the API responds. If the process is killed before that (e.g. user clicks
// Stop in cowork seconds after send), the transcript is left with only
// queue-operation entries; getLastSessionLog filters those out, returns
// null, and --resume fails with "No conversation found".
if (persistSession && messagesFromUserInput.length > 0) {
  const transcriptPromise = recordTranscript(messages)
  if (isBareMode()) {
    void transcriptPromise  // fire-and-forget（脚本模式不需要等）
  } else {
    await transcriptPromise  // 等待写入完成
  }
}
```

**为什么要在 API 调用之前持久化？**

考虑这个场景：用户发了一条消息，Claude Code 开始调用 API，但网络超时或者用户点了 Stop，进程在收到 API 响应之前就结束了。此时 transcript 文件里只有 Claude 的旧消息，没有用户的新消息。下次 `--resume` 时，系统找不到"用户消息"，就不知道从哪里恢复。

先写入用户消息，即使 API 调用失败，至少 `--resume` 能找到这条消息，知道上次的对话到哪里了。

**`isBareMode()` 的优化**：纯脚本模式（`--print`）不需要 `--resume`，所以 `recordTranscript` 可以 fire-and-forget，不阻塞主流程。注释里说 `await` 大约需要 4ms（SSD）到 30ms（磁盘竞争），是关键路径上可以节省的时间。

---

## Step 10：加载 skills + plugins

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L529-L537)**

```typescript
headlessProfilerCheckpoint('before_skills_plugins')
const [skills, { enabled: enabledPlugins }] = await Promise.all([
  getSlashCommandToolSkills(getCwd()),
  loadAllPluginsCacheOnly(),
])
headlessProfilerCheckpoint('after_skills_plugins')
```

并行加载：
- **skills**：从当前目录扫描 `.claude/skills/` 中的自定义 slash command 工具
- **plugins**：加载已安装的插件（`loadAllPluginsCacheOnly` = 只读缓存，不触发网络请求）

注释里说明了为什么用缓存：`CCR populates the cache via CLAUDE_CODE_SYNC_PLUGIN_INSTALL before this runs`——插件的最新版本是由另一个进程在启动时同步的，这里只是读结果。

---

## Step 11：yield buildSystemInitMessage() — SDK 流的第一条消息

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L540-L554)**

```typescript
yield buildSystemInitMessage({
  tools,
  mcpClients,
  model: mainLoopModel,
  permissionMode: initialAppState.toolPermissionContext.mode as PermissionMode,
  commands,
  agents,
  skills,
  plugins: enabledPlugins,
  fastMode: initialAppState.fastMode,
})
```

`submitMessage()` 是一个 `AsyncGenerator`——它用 `yield` 来向 SDK 调用者**流式推送消息**。这是推出的**第一条消息**，类型为 `system/init`。

它包含的信息：

```
{
  type: 'system',
  subtype: 'init',
  cwd: '/path/to/project',
  session_id: 'xxx',
  tools: ['Read', 'Edit', 'Bash', ...],
  mcp_servers: [...],
  model: 'claude-opus-4-6',
  permissionMode: 'default',
  slash_commands: ['/help', '/compact', ...],
  claude_code_version: '1.x.x',
  agents: [...],
  skills: [...],
  plugins: [...],
}
```

**为什么这是第一条消息，而不是在 API 响应之后？**

SDK 调用者（比如 Claude Desktop、远程代理）在收到 `system/init` 消息后，可以立即渲染 UI——显示可用工具、命令列表、当前模型等。如果等 API 响应后再发，用户会看到空白界面。这是流式架构的优势：元数据先到，用户感知的延迟降低。

---

## Step 12：shouldQuery 分支

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L556-L638)**

```
shouldQuery = false（slash command 本地处理）
    ↓
遍历 messagesFromUserInput
    ├── 有 LOCAL_COMMAND_STDOUT_TAG → yield 为 SDKUserMessageReplay
    └── 有 compact_boundary → yield 为 SDKCompactBoundaryMessage
    ↓
持久化 transcript
    ↓
yield result 消息（type: 'result', subtype: 'success'）
    ↓
return（不进入 query 循环）

shouldQuery = true（需要 API 调用）
    ↓
进入 for await (const message of query(...))
```

**slash command 的输出是如何变成 SDK 消息的？**

比如用户运行 `/tools`，`processUserInput()` 返回 `shouldQuery = false`，`messagesFromUserInput` 里有一条内容包含 `<local-command-stdout>工具列表...</local-command-stdout>` 的系统消息。`submitMessage()` 把它包装成 `SDKUserMessageReplay` yield 出去，SDK 调用者渲染为"命令输出"。

result 消息（`type: 'result'`）是每轮对话结束时的汇总：

```typescript
yield {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: Date.now() - startTime,
  duration_api_ms: getTotalAPIDuration(),
  num_turns: messages.length - 1,
  result: resultText ?? '',
  stop_reason: null,
  total_cost_usd: getTotalCost(),
  usage: this.totalUsage,
  permission_denials: this.permissionDenials,  // Step 1 收集的
}
```

---

## processUserInputContext 为什么构建了两次？

细心的读者会发现 `processUserInputContext` 在代码里构建了**两次**——Step 5 一次，Step 7 之后（`query()` 之前）又构建了一次（[src/QueryEngine.ts](../src/QueryEngine.ts#L492-L527)）。

这是有原因的：

第一次构建时，`messages` 是 `this.mutableMessages`（处理 slash command 前的）；slash command 执行后，`messages` 可能被修改（`/compact` 会压缩消息历史），模型可能被更换（`/model`）。第二次构建用来**反映这些变化**，同时把 `setMessages` 改为 no-op（命令已处理完，不再需要修改消息）。

---

## 整体时序图

```
submitMessage(prompt) 
    │
    ├─ [初始化] wrap canUseTool, 解析模型配置
    │
    ├─ [并行] fetchSystemPromptParts()
    │   ├── getSystemPrompt()     → defaultSystemPrompt
    │   ├── getUserContext()      → userContext
    │   └── getSystemContext()    → systemContext
    │
    ├─ [拼装] systemPrompt = [...defaultSystemPrompt, ...appendSystemPrompt]
    │
    ├─ [处理] processUserInput()
    │   ├── slash command → shouldQuery=false, resultText=...
    │   └── 普通输入     → shouldQuery=true, messages=[UserMessage, ...attachments]
    │
    ├─ [持久化] recordTranscript(messages)  ← 先于 API 调用！
    │
    ├─ [并行] getSlashCommandToolSkills() + loadAllPluginsCacheOnly()
    │
    ├─ yield system/init 消息             ← SDK 收到的第一条消息
    │
    ├─ if (!shouldQuery) → yield result, return
    │
    └─ for await (const msg of query(...))  ← 进入下一章的内容
```

---

## 本节小结

- `submitMessage()` 是 12 步的编排器，核心工作是：获取 system prompt、处理用户输入、持久化 transcript、发出初始化消息，然后进入 `query()` 循环
- 用户消息的持久化发生在 API 调用**之前**——这保证了 `--resume` 的可靠性，即使进程在 API 响应前崩溃
- `system/init` 消息是 SDK 流的第一条消息，让调用者可以立即渲染 UI 而不等待 API
- `shouldQuery = false` 路径用于 slash command，直接返回本地结果，不调用 API
- `processUserInputContext` 是系统内部的"服务总线"，被构建两次以反映 slash command 对状态的修改

## 前后呼应

- Step 7 中的 `processUserInput()` 完整讲解见 **[8-2 节](./8-2-processUserInput消息预处理.md)**
- Step 3 中的 `getSystemPrompt()` 和 Step 4 中的 `buildSystemPromptBlocks()` 见 **[8-2 节](./8-2-processUserInput消息预处理.md)** 和 **[8-3 节](./8-3-System-Prompt的构建.md)**
- Step 12 进入的 `query()` 循环是第九部分的主题

## 下一节预告

进入 `query()` 循环了。这是整个系统最核心的部分——一个 `while (true)` 循环，处理 Claude 的流式响应、工具调用、再次响应……直到对话结束。

➡️ [下一节：9-1 queryLoop() 的全局结构](./9-1-queryLoop的全局结构.md)
