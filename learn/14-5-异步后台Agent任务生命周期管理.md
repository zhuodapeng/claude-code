# 14-5 异步后台 Agent：任务的生命周期管理

## 问题引入：后台任务如何让主线程知道它完成了？

主线程 Claude 调用 `Agent(run_in_background: true)` 之后，立刻得到 `async_launched` 响应，开始处理下一个问题。后台 Agent 在独立运行——那么问题来了：

1. 后台 Agent 运行期间，进度信息如何显示？
2. 后台 Agent 完成后，如何通知主线程 Claude？
3. 如果后台 Agent 崩溃了，如何告知？
4. 用户想查看后台 Agent 在做什么，状态存在哪里？
5. 多个后台 Agent 同时运行，如何管理它们的生命周期？

这些问题的答案都在 `LocalAgentTask` 系统里。

---

## 一、LocalAgentTaskState：任务的完整状态机

**文件：[src/tasks/LocalAgentTask/LocalAgentTask.tsx](../src/tasks/LocalAgentTask/LocalAgentTask.tsx#L116-L148)**

```typescript
export type LocalAgentTaskState = TaskStateBase & {
  type: 'local_agent'
  agentId: string             // 唯一标识，也是主线程用来查询状态的 key
  prompt: string              // 原始任务描述（用于 UI 显示）
  agentType: string           // Agent 类型（如 "Explore", "general-purpose"）
  selectedAgent?: AgentDefinition  // 使用的 Agent 定义
  model?: string              // 使用的模型
  abortController?: AbortController  // 用于取消任务
  unregisterCleanup?: () => void  // 进程退出时的清理钩子

  error?: string              // 失败原因
  result?: AgentToolResult    // 成功结果
  progress?: AgentProgress    // 最新进度（工具调用数、token 数等）

  retrieved: boolean          // 主线程是否已经取回结果
  messages?: Message[]        // 子 Agent 的消息历史（UI 显示用）
  lastReportedToolCount: number  // 上次上报的工具调用数（用于增量计算）
  lastReportedTokenCount: number // 上次上报的 token 数

  // 前台/后台状态
  isBackgrounded: boolean    // false = 前台运行（用户在看），true = 已切到后台
  pendingMessages: string[]  // SendMessage 发来的消息队列（等待被注入）

  // UI 持有状态（用于防止过早 GC）
  retain: boolean            // UI 是否持有这个任务（块状 GC）
  diskLoaded: boolean        // sidechain JSONL 是否已加载
  evictAfter?: number        // GC 截止时间戳（到期后可删除）
}
```

`TaskStateBase` 里还包含：
- `status: 'running' | 'completed' | 'failed' | 'killed'`
- `startTime: number`
- `endTime?: number`
- `notified: boolean` (是否已发送完成通知)

整个 `LocalAgentTaskState` 存储在全局 `AppState.tasks[taskId]` 里，所有组件（背景任务面板、主线程消息处理器）都可以读取。

---

## 二、任务的完整生命周期

### 阶段一：注册（Registering）

异步路径里，`registerAsyncAgent()` 把初始状态写入 `AppState`：

```typescript
// AgentTool.tsx 异步路径
const taskId = registerAsyncAgent({
  agentId: earlyAgentId,
  agentType: selectedAgent.agentType,
  prompt,
  description,
  selectedAgent,
  model: resolvedAgentModel,
  setAppState: rootSetAppState,
  toolUseId: toolUseContext.toolUseId,
})
// 立刻返回，不等 Agent 完成
return { data: { status: 'async_launched', agentId: taskId, outputFile: ..., ... } }
```

这一步在 Agent 实际开始运行之前就完成了，所以主线程 Claude 立刻拿到了 `taskId`，UI 也立刻能显示"任务已启动"。

### 阶段二：启动（Starting）

`runAsyncAgentLifecycle()` 在后台启动 Agent，不等待：

```typescript
// 后台启动，不阻塞主线程
runAsyncAgentLifecycle(runAgentParams, {
  taskId,
  setAppState: rootSetAppState,
  onCompletion: () => enqueueAgentNotification(taskId, ...)
})
```

`runAsyncAgentLifecycle()` 是一个 `void` 函数（不被 `await`），意味着调用后立刻返回，Agent 的执行在事件循环里异步进行。

### 阶段三：运行中（Running）

Agent 执行 `runAgent()` 的过程中，每收到一条来自 Claude API 的消息，都会更新进度：

**文件：[src/tools/AgentTool/agentToolUtils.ts](../src/tools/AgentTool/agentToolUtils.ts#L68-L95)**

```typescript
export function updateProgressFromMessage(
  tracker: ProgressTracker,
  message: Message,
  resolveActivityDescription?: ActivityDescriptionResolver,
  tools?: Tools,
): void {
  if (message.type !== 'assistant') return

  const usage = message.message.usage
  // 注意：input_tokens 是累积值（每轮都包含之前所有 context），
  // output_tokens 是本轮新增值——需要分别处理
  tracker.latestInputTokens = usage.input_tokens
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
  tracker.cumulativeOutputTokens += usage.output_tokens  // 累加

  for (const content of message.message.content) {
    if (content.type === 'tool_use') {
      tracker.toolUseCount++
      tracker.recentActivities.push({
        toolName: content.name,
        input: content.input,
        activityDescription: resolveActivityDescription?.(content.name, content.input),
        isSearch: ..., isRead: ...,
      })
    }
  }
  // 保留最近 5 条活动记录
  while (tracker.recentActivities.length > MAX_RECENT_ACTIVITIES) {
    tracker.recentActivities.shift()
  }
}
```

`input_tokens` 不能直接累加的设计值得深入理解：Anthropic API 的 `input_tokens` 字段在每轮里包含整个 context（历史消息 + 本轮输入），所以随着对话进行它会不断增大。如果简单累加所有轮次的 `input_tokens`，就会严重高估实际消耗。正确做法是只取最后一轮的 `input_tokens`（它已经包含了所有历史），再加上所有轮次的 `output_tokens` 之和。

UI 定期从 `tracker` 取出 `AgentProgress` 快照并更新 AppState：

```typescript
export function getProgressUpdate(tracker: ProgressTracker): AgentProgress {
  return {
    toolUseCount: tracker.toolUseCount,
    tokenCount: tracker.latestInputTokens + tracker.cumulativeOutputTokens,
    lastActivity: tracker.recentActivities[tracker.recentActivities.length - 1],
    recentActivities: [...tracker.recentActivities],
  }
}
```

这个快照会显示在 UI 的任务面板里，用户可以看到"Agent 已使用 23 个工具，消耗了 45,000 token，最近在读 src/foo.ts"。

### 阶段四：完成/失败/被杀（Terminal）

任务结束时，`completeAgentTask()` 或 `failAgentTask()` 或 `killAsyncAgent()` 被调用：

**文件：[src/tasks/LocalAgentTask/LocalAgentTask.tsx](../src/tasks/LocalAgentTask/LocalAgentTask.tsx#L281-L303)**

```typescript
export function killAsyncAgent(taskId: string, setAppState: SetAppState): void {
  let killed = false
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task  // 幂等：避免重复处理
    killed = true
    task.abortController?.abort()   // 信号给子 Agent 的 AbortController
    task.unregisterCleanup?.()      // 取消进程退出清理钩子
    return {
      ...task,
      status: 'killed',
      endTime: Date.now(),
      evictAfter: task.retain ? undefined : Date.now() + PANEL_GRACE_MS,
      abortController: undefined,
      unregisterCleanup: undefined,
      selectedAgent: undefined,     // 释放 AgentDefinition 对象
    }
  })
  if (killed) {
    void evictTaskOutput(taskId)  // 删除磁盘输出文件
  }
}
```

`PANEL_GRACE_MS` 是一个宽限期（通常几分钟），在任务结束后 UI 面板还会显示一段时间，让用户有机会查看结果。过了宽限期后，`evictAfter` 时间戳触发 GC，任务状态从 AppState 里移除。

### 阶段五：通知（Notification）

任务完成后，`enqueueAgentNotification()` 构建一条 XML 格式的通知消息，塞进主线程的消息队列：

**文件：[src/tasks/LocalAgentTask/LocalAgentTask.tsx](../src/tasks/LocalAgentTask/LocalAgentTask.tsx#L247-L262)**

```typescript
const message = `<task-notification>
<task-id>${taskId}</task-id>
<tool-use-id>${toolUseId}</tool-use-id>
<output-file>${outputPath}</output-file>
<status>${status}</status>
<summary>Agent "${description}" completed</summary>
<result>${finalMessage}</result>
<usage>
  <total-tokens>${usage.totalTokens}</total-tokens>
  <tool-uses>${usage.toolUses}</tool-uses>
  <duration-ms>${usage.durationMs}</duration-ms>
</usage>
<worktree>
  <path>${worktreePath}</path>
  <branch>${worktreeBranch}</branch>
</worktree>
</task-notification>`

enqueuePendingNotification({ value: message, mode: 'task-notification' })
```

这条消息会在主线程 Claude 的下一轮 API 调用开始前被注入到消息历史里。主线程 Claude 看到 `<task-notification>` 时，就知道哪个后台任务完成了，可以读取 `<output-file>` 里的结果文件。

---

## 三、防止重复通知的原子操作

一个微妙的问题：如果用户手动取消了一个正在完成的任务，通知可能会被发送两次。为了解决这个问题，`enqueueAgentNotification()` 使用了原子操作：

```typescript
let shouldEnqueue = false
updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
  if (task.notified) {   // 已经通知过了，跳过
    return task
  }
  shouldEnqueue = true
  return { ...task, notified: true }  // 原子地标记"已通知"
})
if (!shouldEnqueue) return  // 如果已标记，不发送重复通知
```

`updateTaskState` 是一个在 React state 的 functional update 里执行的操作，它是原子的——即使多个并发调用，`notified` 标志只会被设置一次，通知只会发送一次。

---

## 四、SendMessage：向运行中的后台 Agent 发消息

后台 Agent 启动后，主线程 Claude 可以通过 `SendMessage` 工具继续与它通信：

```json
{
  "type": "tool_use",
  "name": "SendMessage",
  "input": {
    "to": "agent-abc12345",
    "message": "请优先处理认证模块"
  }
}
```

发来的消息通过 `queuePendingMessage()` 进入 `LocalAgentTaskState.pendingMessages` 队列：

**文件：[src/tasks/LocalAgentTask/LocalAgentTask.tsx](../src/tasks/LocalAgentTask/LocalAgentTask.tsx#L162-L167)**

```typescript
export function queuePendingMessage(
  taskId: string, msg: string, setAppState: SetAppState
): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => ({
    ...task,
    pendingMessages: [...task.pendingMessages, msg]
  }))
}
```

在子 Agent 的 query 循环里，每完成一轮工具执行后，`drainPendingMessages()` 会取出积压的消息，作为新的用户消息注入到子 Agent 的下一轮对话里：

```typescript
export function drainPendingMessages(
  taskId: string, getAppState: () => AppState, setAppState: SetAppState
): string[] {
  const task = getAppState().tasks[taskId]
  if (!isLocalAgentTask(task) || task.pendingMessages.length === 0) return []

  const drained = task.pendingMessages
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, t => ({
    ...t, pendingMessages: []  // 原子清空
  }))
  return drained
}
```

`pendingMessages` 数组作为一个简单的消息队列，利用 AppState 的不可变更新语义保证原子性。

---

## 五、ProgressTracker 的精确 token 计数

token 计数的逻辑值得单独讲清楚，因为它很容易出错。

**文件：[src/tasks/LocalAgentTask/LocalAgentTask.tsx](../src/tasks/LocalAgentTask/LocalAgentTask.tsx#L41-L49)**

```typescript
export type ProgressTracker = {
  toolUseCount: number
  // 两个字段分别追踪，因为 API 的计数语义不同
  latestInputTokens: number         // 只保留最新一轮（因为是累积值）
  cumulativeOutputTokens: number    // 累加所有轮次
  recentActivities: ToolActivity[]
}

export function getTokenCountFromTracker(tracker: ProgressTracker): number {
  return tracker.latestInputTokens + tracker.cumulativeOutputTokens
}
```

举个例子说明为什么这么设计：

假设子 Agent 进行了 3 轮 API 调用：

| 轮次 | API 返回的 input_tokens | API 返回的 output_tokens |
|------|----------------------|----------------------|
| 第 1 轮 | 5,000（包含整个历史）| 200 |
| 第 2 轮 | 5,500（包含第 1 轮结果）| 300 |
| 第 3 轮 | 6,200（包含前 2 轮结果）| 150 |

- 错误做法：`(5000+5500+6200) + (200+300+150) = 17,350` → 严重高估
- 正确做法：`6200 + (200+300+150) = 6,850` → 真实消耗

`latestInputTokens` 只记录最后一次 API 调用的 `input_tokens`，因为它已经包含了所有历史的 token 消耗。`cumulativeOutputTokens` 则是各轮输出 token 的真实累加。

---

## 六、finalizeAgentTool() 和缓存驱逐提示

任务完成时，`finalizeAgentTool()` 不只是整理结果，还会发一个 `tengu_cache_eviction_hint` 遥测事件：

**文件：[src/tools/AgentTool/agentToolUtils.ts](../src/tools/AgentTool/agentToolUtils.ts#L337-L346)**

```typescript
// 通知推理服务可以驱逐这个子 Agent 的 prompt cache
const lastRequestId = lastAssistantMessage.requestId
if (lastRequestId) {
  logEvent('tengu_cache_eviction_hint', {
    scope: 'subagent_end',
    last_request_id: lastRequestId,
  })
}
```

子 Agent 结束后，它建立的 prompt cache 条目不再有人使用，但 Anthropic 的推理服务不会立刻驱逐它们——可能还会占用服务端资源一段时间。这个事件提示推理服务"这个 agent 的 cache 可以驱逐了"，有助于释放服务端的 cache slot，让其他请求有更多空间。

---

## 七、handoff 分类器：子 Agent 结果的安全检查

子 Agent 完成后、把结果返回给主线程之前，有一个可选的安全分类器检查：

**文件：[src/tools/AgentTool/agentToolUtils.ts](../src/tools/AgentTool/agentToolUtils.ts#L389-L478)**

```typescript
export async function classifyHandoffIfNeeded({
  agentMessages, tools, toolPermissionContext, ...
}): Promise<string | null> {
  if (feature('TRANSCRIPT_CLASSIFIER') && toolPermissionContext.mode === 'auto') {
    // 调用 AI 分类器，分析子 Agent 的行为记录
    const classifierResult = await classifyYoloAction(agentMessages, {
      role: 'user',
      content: [{
        type: 'text',
        text: "Sub-agent has finished. Review the sub-agent's work and let the main agent know if any action is dangerous.",
      }],
      ...
    }, ...)

    if (classifierResult.shouldBlock) {
      return `SECURITY WARNING: This sub-agent performed actions that may violate security policy.
Reason: ${classifierResult.reason}.
Review the sub-agent's actions carefully before acting on its output.`
    }
  }
  return null  // 没问题
}
```

这是第 11 章讲过的 AI 分类器在多 Agent 场景里的应用：当主线程处于 `auto` 模式时，子 Agent 完成后会多一步 "handoff 审查"，由另一个 Claude 实例检查子 Agent 是否做了危险操作。如果审查发现问题，主线程会收到带有警告的结果，而不是直接信任子 Agent 的输出。

---

## 本节小结

`LocalAgentTask` 系统是多 Agent 异步执行的基础设施。任务状态存在 `AppState.tasks` 里，形成一个简单的状态机（running → completed/failed/killed）。进度追踪使用 `ProgressTracker` 精确计算 token 消耗（分别处理累积的 input 和增量的 output）。通知机制通过 `enqueuePendingNotification` 把完成消息注入主线程消息队列。`notified` 标志的原子操作防止重复通知。`SendMessage` 通过 `pendingMessages` 队列实现主线程与后台 Agent 的异步通信。

## 前后呼应

- `enqueueAgentNotification` 构建的 `<task-notification>` XML 格式，与 **[9-7 节](./9-7-工具结果如何喂回给Claude.md)** 里讲的工具结果注入机制直接相关
- 子 Agent 的 `AbortController` 层级，在 **[14-3 节](./14-3-子Agent的隔离独立Context窗口.md)** 里已经详细介绍

## 下一节预告

到目前为止讲的都是"主 Agent 派发子 Agent"的模式。但还有一种完全不同的思路：Fork 模式——Claude 主动将自己的当前对话分叉，派出多个"副本"并行处理不同的子任务。这如何实现 prompt cache 共享，以及这些副本的输出如何汇总？

➡️ [下一节：14-6 Fork 子 Agent：从对话中分叉](./14-6-Coordinator模式多Agent的指挥官.md)
