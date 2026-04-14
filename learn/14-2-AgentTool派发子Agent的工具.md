# 14-2 AgentTool：派发子 Agent 的工具

## 问题引入：一个工具，四种结果

Claude 调用 `Agent` 工具，会得到四种截然不同的结果之一：
1. 子 Agent 完成任务，返回结果文本（同步）
2. 子 Agent 在后台启动，立即返回一个 agentId（异步）
3. 一个 Teammate 被派生到新的终端窗口（多 Agent 团队模式）
4. 子 Agent 在远程 CCR 环境里运行（ant 内部专用）

这四种结果对应着四套完全不同的执行路径，但 Claude 只看到同一个工具调用。本节讲清楚 `AgentTool.tsx` 的全部内部逻辑：**从工具调用的参数到最终执行路径的选择**。

---

## 一、InputSchema：允许 Claude 传入什么参数

**文件：[src/tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx#L82-L125)**

```typescript
// 基础 schema（始终存在）
const baseInputSchema = z.object({
  description: z.string()       // 3-5 词摘要，用于 UI 显示和 task notification
  prompt: z.string()            // 交给子 Agent 的完整任务描述
  subagent_type: z.string().optional()  // 指定 Agent 类型（可选）
  model: z.enum(['sonnet', 'opus', 'haiku']).optional()  // 模型覆盖
  run_in_background: z.boolean().optional()  // 是否异步
})

// 多 Agent 参数（Swarm 模式下启用）
const multiAgentInputSchema = z.object({
  name: z.string().optional()           // Agent 名称（可被 SendMessage 定向发送）
  team_name: z.string().optional()      // 所属团队名
  mode: permissionModeSchema().optional()  // 权限模式（如 "plan"）
})

// 完整 schema = 基础 + 多 Agent + 隔离参数
const fullInputSchema = baseInputSchema.merge(multiAgentInputSchema).extend({
  isolation: z.enum(['worktree']).optional()  // 隔离模式
  cwd: z.string().optional()  // 覆盖工作目录（Kairos 功能）
})
```

注意 `run_in_background` 的特殊处理（[L122](../src/tools/AgentTool/AgentTool.tsx#L122)）：

```typescript
return isBackgroundTasksDisabled || isForkSubagentEnabled()
  ? schema.omit({ run_in_background: true })  // 从 schema 里整个删掉！
  : schema
```

当 Fork 实验开启时，`run_in_background` 字段从 schema 里消失——Claude 根本看不到这个参数的存在。这是因为 Fork 模式下**所有** Agent 都被强制异步运行（[L557](../src/tools/AgentTool/AgentTool.tsx#L557)），让 Claude 传 `run_in_background` 没有意义，而且会产生误导。

同样，当 `isBackgroundTasksDisabled=true` 时也会删除，保持 schema 与实际能力一致。

---

## 二、OutputSchema：四种返回值

**文件：[src/tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx#L141-L191)**

```typescript
// 同步完成
{
  status: 'completed',
  agentId: string,      // 子 Agent 的 ID
  content: string,      // 子 Agent 最后的文本输出
  totalTokens: number,  // 消耗的总 token 数
  prompt: string,       // 回显输入的 prompt
}

// 异步启动（后台运行）
{
  status: 'async_launched',
  agentId: string,           // 用于后续追踪的 ID
  description: string,       // 任务描述
  prompt: string,            // 回显
  outputFile: string,        // 输出文件路径（可轮询检查进度）
  canReadOutputFile: boolean // 调用 Agent 是否有 Read 工具
}

// Teammate 派生（Swarm 模式，未导出到公共 schema）
{
  status: 'teammate_spawned',
  teammate_id: string,
  agent_id: string,
  name: string,
  tmux_session_name: string, // tmux 会话名
  ...
}

// 远程启动（ant 内部专用，未导出到公共 schema）
{
  status: 'remote_launched',
  taskId: string,
  sessionUrl: string,
  outputFile: string,
}
```

`TeammateSpawnedOutput` 和 `RemoteLaunchedOutput` 刻意**不**导出到公共 schema（注释 [L159](../src/tools/AgentTool/AgentTool.tsx#L159)）：

```
// Private type for teammate spawn results - excluded from exported schema
// for dead code elimination
```

这是一个代码大小优化：如果这两种类型出现在公共 schema 里，编译器就无法在非 ant 构建中把对应代码树摇掉（tree-shaking）。把它们藏在私有类型里，可以让外部构建的代码体积更小。

---

## 三、路由逻辑：从参数到执行路径

`AgentTool.call()` 里的路由逻辑是一个多层决策树。让我们按执行顺序梳理：

### 第一层：Teammate 路由（多 Agent 团队）

**文件：[src/tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx#L283-L316)**

```typescript
// 同时有 team_name 和 name 参数 → 派生 Teammate
if (teamName && name) {
  const result = await spawnTeammate({
    name, prompt, description, team_name: teamName,
    plan_mode_required: spawnMode === 'plan',
    // ...
  }, toolUseContext)
  return { status: 'teammate_spawned', ... }
}
```

如果 `team_name` 和 `name` 同时存在，走 Teammate 路径，完全绕过后面的 Agent 逻辑。

### 第二层：Fork 路由还是 Agent 路由？

**文件：[src/tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx#L318-L356)**

```typescript
// subagent_type 为空 + fork 实验开启 → fork 路径
const effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : GENERAL_PURPOSE_AGENT.agentType)
const isForkPath = effectiveType === undefined

if (isForkPath) {
  // 递归守卫：如果已经在 fork child 里，禁止再 fork
  if (toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}`
    || isInForkChild(toolUseContext.messages)) {
    throw new Error('Fork is not available inside a forked worker. Complete your task directly using your tools.')
  }
  selectedAgent = FORK_AGENT
} else {
  // 在 activeAgents 里找指定的 agentType
  const found = agents.find(agent => agent.agentType === effectiveType)
  if (!found) { /* 检查是否被权限规则拒绝 */ }
  selectedAgent = found
}
```

这里有一个递归守卫：Fork 子 Agent 的 `querySource` 会被设置为 `agent:builtin:fork`，同时消息历史里会包含 `FORK_BOILERPLATE_TAG`。任何一个条件满足，都会拒绝再次 fork，防止无限嵌套。

### 第三层：是否需要 Worktree 隔离？

**文件：[src/tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx#L590-L602)**

```typescript
const effectiveIsolation = isolation ?? selectedAgent.isolation  // 参数 > Agent 定义

if (effectiveIsolation === 'worktree') {
  const slug = `agent-${earlyAgentId.slice(0, 8)}`
  worktreeInfo = await createAgentWorktree(slug)  // 创建 git worktree
}

// Fork + worktree：给子 Agent 注入一条提示，告诉它自己在隔离目录里
if (isForkPath && worktreeInfo) {
  promptMessages.push(createUserMessage({
    content: buildWorktreeNotice(getCwd(), worktreeInfo.worktreePath)
  }))
}
```

Worktree 隔离会创建一个独立的 git 工作树，子 Agent 在那里做的任何文件修改都不会影响父 Agent 的工作目录。具体机制见 14-4 节。

### 第四层：同步还是异步？

**文件：[src/tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx#L555-L567)**

```typescript
// 以下任一条件成立 → 异步运行
const shouldRunAsync = (
  run_in_background === true    // 用户明确指定
  || selectedAgent.background === true  // Agent 定义强制后台
  || isCoordinator              // Coordinator 模式下全部异步
  || forceAsync                 // Fork 实验开启（全部异步）
  || assistantForceAsync        // Kairos 模式
  || proactiveModule?.isProactiveActive()  // 主动模式
) && !isBackgroundTasksDisabled
```

六个条件取 OR，再 AND 一个"后台任务未被禁用"的门。这意味着：
- 用户显式传 `run_in_background: true`
- 或者 Agent 定义里配置了 `background: true`
- 或者当前处于 Coordinator/Fork/Kairos 模式

满足任一条件，子 Agent 就会异步运行。

---

## 四、Fork 路径 vs 普通路径：系统提示的关键差异

**文件：[src/tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx#L483-L541)**

这是整个文件里最精妙的一段代码：

```typescript
if (isForkPath) {
  // Fork 路径：使用父 Agent 的系统提示（字节完全一致）
  if (toolUseContext.renderedSystemPrompt) {
    forkParentSystemPrompt = toolUseContext.renderedSystemPrompt  // 直接用已渲染的
  } else {
    // 降级：重新计算，但可能因为 GrowthBook 状态变化而不一致
    forkParentSystemPrompt = buildEffectiveSystemPrompt({...})
  }
  promptMessages = buildForkedMessages(prompt, assistantMessage)  // 特殊消息构建

} else {
  // 普通路径：用子 Agent 自己的系统提示
  const agentPrompt = selectedAgent.getSystemPrompt({ toolUseContext })
  enhancedSystemPrompt = await enhanceSystemPromptWithEnvDetails([agentPrompt], ...)
  promptMessages = [createUserMessage({ content: prompt })]  // 简单用户消息
}
```

**为什么 Fork 路径要使用父 Agent 的系统提示？**

Anthropic API 的 prompt cache 键由"系统提示 + 工具列表 + 模型 + 消息前缀"组成。如果 Fork 子 Agent 用自己的系统提示，cache 键就不同了，父 Agent 辛苦建立的 prompt cache 就白费了。

`toolUseContext.renderedSystemPrompt` 存储的是父 Agent **上一轮已经发送过的系统提示的字节**，这保证了 Fork 子 Agent 发的第一个请求能命中父 Agent 的 cache。

`buildForkedMessages()` 的细节在 14-6 节讲解。

---

## 五、工具池组装：子 Agent 有自己的权限沙盒

**文件：[src/tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx#L572-L577)**

```typescript
// 以子 Agent 自己的权限模式重新组装工具池
const workerPermissionContext = {
  ...appState.toolPermissionContext,
  mode: selectedAgent.permissionMode ?? 'acceptEdits'  // 默认 acceptEdits
}
const workerTools = assembleToolPool(workerPermissionContext, appState.mcp.tools)
```

子 Agent 的工具池**独立于父 Agent 组装**，使用子 Agent 自己的权限模式：

- 父 Agent 处于 `ask` 模式（每次都问用户）
- 子 Agent 定义了 `permissionMode: 'acceptEdits'`（自动接受所有文件修改）
- 那么子 Agent 可以自由地读写文件，而不会弹出权限确认框

这是有意设计的——子 Agent 的能力边界由它自己的 `AgentDefinition` 决定，与父 Agent 的权限状态解耦。

Fork 路径例外（[L627](../src/tools/AgentTool/AgentTool.tsx#L627)）：
```typescript
availableTools: isForkPath ? toolUseContext.options.tools : workerTools
// Fork 子 Agent 直接继承父 Agent 的工具列表（cache 命中）
// 普通子 Agent 用独立组装的工具池
```

Fork 子 Agent 必须用和父 Agent 完全相同的工具列表，否则 API 请求的 cache 键不同，前面的所有 cache 优化都白做了。

---

## 六、Agent 被选中之后：runAgent() 的参数构建

确定了路径和选定了 Agent 之后，所有路径最终都调用 `runAgent()`（或 `runAsyncAgentLifecycle()`）：

**文件：[src/tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx#L603-L628)**

```typescript
const runAgentParams = {
  agentDefinition: selectedAgent,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync: shouldRunAsync,
  querySource: getQuerySourceForAgent(selectedAgent.agentType, isBuiltIn),
  model: isForkPath ? undefined : model,  // Fork 不改模型（cache 键里有模型名）
  override: isForkPath
    ? { systemPrompt: forkParentSystemPrompt }  // Fork：复用父系统提示
    : enhancedSystemPrompt && !worktreeInfo && !cwd
      ? { systemPrompt: asSystemPrompt(enhancedSystemPrompt) }
      : undefined,  // 普通：用已构建的系统提示
  availableTools: isForkPath
    ? toolUseContext.options.tools  // Fork：父工具池（cache 命中）
    : workerTools,                  // 普通：独立工具池
  forkContextMessages: isForkPath  // Fork：传入父会话历史
    ? toolUseContext.messages
    : undefined,                    // 普通：独立开始
  useExactTools: isForkPath,       // Fork：跳过工具过滤（保持 cache 一致）
  worktreePath: worktreeInfo?.worktreePath,
}
```

`querySource` 是一个非常重要的参数，它的格式是 `agent:builtin:<agentType>` 或 `agent:custom`。这个值会被传入子 Agent 的 `query()` 循环，成为那个子 Agent 的"身份证"——决定它能否触发压缩、能否加载记忆等行为（见第 13 章的 `shouldAutoCompact()` 递归守卫）。

---

## 七、同步 vs 异步：最后的分叉

**文件：[src/tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx#L640-L720)** （大致位置）

```typescript
if (!shouldRunAsync) {
  // 同步执行：主线程在这里等待，直到子 Agent 完成
  for await (const message of runAgent(runAgentParams)) {
    // 把子 Agent 的消息通过 onProgress 传递给主线程 UI
    if (onProgress) {
      onProgress(...)
    }
  }
  return { data: { status: 'completed', content: ..., agentId: ..., ... } }

} else {
  // 异步执行：注册后台任务，立即返回 agentId
  const taskId = registerAsyncAgent({...})
  runAsyncAgentLifecycle(runAgentParams, {
    taskId,
    setAppState: rootSetAppState,
    onCompletion: () => enqueueAgentNotification(taskId, ...)
  })
  return { data: { status: 'async_launched', agentId: taskId, outputFile: ..., ... } }
}
```

同步路径：`for await` 等待子 Agent 所有消息——这意味着主线程 Claude 的整个 API 轮次都被阻塞，直到子 Agent 完成。

异步路径：`runAsyncAgentLifecycle()` 在后台启动子 Agent，主线程立刻返回 `async_launched`。子 Agent 完成后，通过 `enqueueAgentNotification()` 把完成通知塞进主线程的消息队列，Claude 会在下一轮看到 `<task-notification>` 消息。

---

## 本节小结

`AgentTool.call()` 是一个复杂的路由器，按顺序检查：Teammate 路径 → Fork 路径 vs Agent 路径 → Worktree 隔离 → 同步/异步分叉。最精妙的设计在于 Fork 路径：通过继承父 Agent 的系统提示和工具列表，子 Agent 可以命中父 Agent 的 prompt cache，大幅节省 token 费用。工具池独立组装保证了子 Agent 有自己的权限沙盒，不受父 Agent 权限状态影响。

## 前后呼应

- 本节提到的 `querySource` 格式与 **[13-2 节](./13-2-AutoCompact触发时机.md)** 里的递归守卫直接关联
- Fork 路径的 `buildForkedMessages()` 细节在 **[14-6 节](./14-6-Coordinator模式多Agent的指挥官.md)** 里深入讲解
- 工具池组装 `assembleToolPool()` 在 **[7-7 节](./7-7-工具注册表assembleToolPool.md)** 里有完整介绍

## 下一节预告

子 Agent 启动后，它的 `ToolUseContext` 是如何从父 Agent 隔离出来的？`createSubagentContext()` 具体克隆了什么、共享了什么——这是理解多 Agent 系统隔离性的关键。

➡️ [下一节：14-3 子 Agent 的隔离：独立 Context 窗口](./14-3-子Agent的隔离独立Context窗口.md)
