# 14-7 Swarm 模式与 Teammate 模式

## 问题引入：不是"主-从"，而是"团队"

前面所有的多 Agent 模式都是**层级式**的：主 Agent 处于中心地位，子 Agent 只是工具的执行者。子 Agent 没有自主性，它完成任务后汇报结果，就此结束。

但有些任务需要更高程度的协作：多个 Agent 并行工作，互相知道对方在做什么，可以互发消息协调，每个 Agent 都有自己的身份和专长……像一个真正的团队，而不是一个人和他的工具箱。

这就是 **Swarm 模式**（`ENABLE_AGENT_SWARMS` 功能门）的核心想法：多个 **Teammate** Agent 在同一个进程里并行运行，通过 **邮箱（mailbox）** 系统互相通信，共享一个统一的 UI 界面。

---

## 一、Teammate 的身份标识

每个 Teammate 有一个唯一的身份，存储在 `TeammateIdentity` 里：

**文件：[src/tasks/InProcessTeammateTask/types.ts](../src/tasks/InProcessTeammateTask/types.ts#L13-L20)**

```typescript
export type TeammateIdentity = {
  agentId: string          // e.g., "researcher@my-team"（name@teamName 格式）
  agentName: string        // e.g., "researcher"
  teamName: string         // e.g., "my-team"
  color?: string           // UI 显示颜色（每个 teammate 不同颜色）
  planModeRequired: boolean  // 是否需要 plan 模式审批
  parentSessionId: string  // Leader（主 Agent）的 session ID
}
```

`agentId` 采用 `name@teamName` 格式，让它既可以用于精确定向（发消息给"researcher@my-team"），也可以用于模糊匹配（发消息给"researcher"，如果上下文里只有一个叫这个名字的 teammate）。

注意区分两个概念：
- `TeammateIdentity`：存在 AppState 里的**序列化数据**（可以跨组件读取）
- `TeammateContext`：存在 `AsyncLocalStorage` 里的**运行时上下文**（只在当前执行链里可见）

---

## 二、AsyncLocalStorage：同进程内的身份隔离

多个 Teammate 在同一个 Node.js 进程里并发运行。问题是：每个 Teammate 的工具调用都在同一个线程里执行，如何让它们"知道自己是谁"而不混淆？

答案是 Node.js 的 `AsyncLocalStorage`——它允许在同一个线程里的不同异步调用链中维护独立的"本地存储"，类似于线程本地变量（Thread-local storage）的概念。

**文件：[src/utils/teammateContext.ts](../src/utils/teammateContext.ts)**（概念示意）

```typescript
const teammateContextStorage = new AsyncLocalStorage<TeammateContext>()

// 在特定的 async 调用链里设置 Teammate 上下文
export function runWithTeammateContext<T>(
  context: TeammateContext,
  fn: () => Promise<T>
): Promise<T> {
  return teammateContextStorage.run(context, fn)
}

// 在任意深度的 async 函数里读取当前的 Teammate 上下文
export function isTeammate(): boolean {
  return teammateContextStorage.getStore() !== undefined
}

export function isInProcessTeammate(): boolean {
  const ctx = teammateContextStorage.getStore()
  return ctx?.type === 'in-process'
}
```

当 `inProcessRunner.ts` 启动一个 Teammate 时，它用 `runWithTeammateContext(identity, runAgentFn)` 包裹整个执行过程。这样，在 Teammate 的整个执行链里（无论多少层 await、无论调用多少工具），`isTeammate()` 和 `getTeammateContext()` 都能正确返回这个 Teammate 的身份，而不会与其他并发 Teammate 混淆。

这解决了一个根本难题：**同进程并发时如何区分"谁在说话"**。不需要到处传递 identity 参数，AsyncLocalStorage 自动追踪整个 async 调用链的上下文。

---

## 三、InProcessTeammateTaskState：Teammate 的完整状态

**文件：[src/tasks/InProcessTeammateTask/types.ts](../src/tasks/InProcessTeammateTask/types.ts#L22-L76)**

```typescript
export type InProcessTeammateTaskState = TaskStateBase & {
  type: 'in_process_teammate'
  identity: TeammateIdentity   // 静态身份信息

  // 执行状态
  prompt: string
  model?: string
  selectedAgent?: AgentDefinition
  abortController?: AbortController         // 杀死整个 teammate
  currentWorkAbortController?: AbortController  // 中止当前轮次（不杀死）

  // Plan 模式
  awaitingPlanApproval: boolean    // 正在等待 leader 批准计划
  permissionMode: PermissionMode   // 可独立切换（Shift+Tab 在 UI 里循环）

  // 历史（UI 显示用）
  messages?: Message[]             // 最多保留 50 条（TEAMMATE_MESSAGES_UI_CAP）
  inProgressToolUseIDs?: Set<string>  // 正在执行的工具（UI 动画用）
  pendingUserMessages: string[]    // 等待注入的用户消息

  // 空闲通知
  isIdle: boolean
  shutdownRequested: boolean
  onIdleCallbacks?: Array<() => void>  // 高效等待，不轮询
}
```

`TEAMMATE_MESSAGES_UI_CAP = 50` 背后有一段真实的生产事故记录：

**文件：[src/tasks/InProcessTeammateTask/types.ts](../src/tasks/InProcessTeammateTask/types.ts#L89-L100)**

```
// BQ analysis (round 9, 2026-03-20) showed ~20MB RSS per agent at 500+ turn
// sessions and ~125MB per concurrent agent in swarm bursts. Whale session
// 9a990de8 launched 292 agents in 2 minutes and reached 36.8GB. The dominant
// cost is this array holding a second full copy of every message.
```

一个会话在 2 分钟内启动了 292 个 Agent，每个 Agent 都在 AppState 里保留全量消息历史，导致 RSS 达到 36.8GB。分析发现主要原因就是这个 `messages` 数组——它是完整消息历史的第二份拷贝（第一份在 Agent 自己的 `allMessages` 里）。

限制为 50 条解决了这个问题：UI 只需要最近的上下文来显示进度，不需要全量历史；全量历史在 Agent 内部的 `allMessages` 和磁盘 JSONL 里。

---

## 四、Mailbox 系统：Teammate 之间的通信协议

Teammate 之间不直接调用对方，而是通过**邮箱**发消息：

**文件：[src/utils/teammateMailbox.ts](../src/utils/teammateMailbox.ts)**（概念）

```typescript
// Teammate A 写消息给 Teammate B
await writeToMailbox(recipientId, {
  sender: 'researcher@team',
  content: '我找到了 API 的入口点，在 src/api/index.ts L234',
  timestamp: Date.now(),
})

// Teammate B 读取自己的邮箱
const messages = await readMailbox(myId)

// Leader 读取自己的邮箱（收到权限请求、状态更新等）
const leaderMessages = await readMailbox(TEAM_LEAD_NAME)
```

邮箱系统支持几种特殊消息类型：

```typescript
export function createIdleNotification(from: string) {
  return { type: 'idle', sender: from }
}

export function isPermissionResponse(msg: unknown): boolean {
  // 检查是否是对权限请求的响应
}

export function isShutdownRequest(msg: unknown): boolean {
  // 检查是否是关闭请求
}
```

`isIdle` 通知是 Teammate 完成当前任务后发给 Leader 的信号，用于告知 Leader "我空闲了，可以给我新任务"。

---

## 五、权限流的特殊处理：Teammate 如何请求权限

在普通 Agent 里，权限确认是直接弹出 UI 对话框（主线程 Claude 本身就控制 UI）。但 Teammate 是后台运行的，它的工具调用需要借助 **Leader（主 Agent）的 UI** 来显示权限确认框。

**文件：[src/utils/swarm/inProcessRunner.ts](../src/utils/swarm/inProcessRunner.ts#L128-L199)**

```typescript
function createInProcessCanUseTool(identity, abortController, ...): CanUseToolFn {
  return async (tool, input, toolUseContext, ...) => {
    const result = await hasPermissionsToUseTool(tool, input, ...)

    if (result.behavior !== 'ask') {
      return result  // 已有答案（允许/拒绝），直接返回
    }

    // 对于 Bash 命令：先试试 AI 分类器自动审批
    if (feature('BASH_CLASSIFIER') && tool.name === BASH_TOOL_NAME) {
      const classifierDecision = await awaitClassifierAutoApproval(...)
      if (classifierDecision) return { behavior: 'allow', ... }
    }

    // 尝试通过 Leader 的 ToolUseConfirm 对话框
    const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()
    if (setToolUseConfirmQueue) {
      // 把权限请求推入 Leader 的确认队列
      // Leader 的 UI 会显示"[researcher] 需要执行 git commit..."
      return new Promise(resolve => {
        setToolUseConfirmQueue(prev => [...prev, {
          tool, input, identity, resolve
        }])
      })
    }

    // 降级：通过邮箱系统发送权限请求
    await sendPermissionRequestViaMailbox(identity, ...)
    // 轮询邮箱等待响应
    while (!abortController.signal.aborted) {
      await sleep(PERMISSION_POLL_INTERVAL_MS)  // 500ms
      const response = await processMailboxPermissionResponse(...)
      if (response) return response
    }
  }
}
```

权限请求有两条路：
1. **Leader 桥（`getLeaderToolUseConfirmQueue`）**：如果 Leader 的 UI 还在（交互式会话），把权限请求推入 Leader 的确认队列，Leader 的 UI 会显示带有 Teammate 标识的确认框（用户能看到"是哪个 Agent 在请求权限"）
2. **邮箱系统（降级）**：Leader 桥不可用时，通过邮箱发送权限请求，轮询等待响应（500ms 间隔）

这种设计保证了即使 Teammate 在后台运行，它的权限请求也能到达用户，而不是静默拒绝或挂起。

---

## 六、TEAMMATE_MESSAGES_UI_CAP 和内存压力的完整解决方案

上面提到了 36.8GB 内存问题，完整的解决方案是 `appendCappedMessage()`：

**文件：[src/tasks/InProcessTeammateTask/types.ts](../src/tasks/InProcessTeammateTask/types.ts#L108-L122)**

```typescript
export const TEAMMATE_MESSAGES_UI_CAP = 50

export function appendCappedMessage<T>(
  prev: readonly T[] | undefined,
  item: T,
): T[] {
  if (prev === undefined || prev.length === 0) {
    return [item]
  }
  if (prev.length >= TEAMMATE_MESSAGES_UI_CAP) {
    // 滑动窗口：删除最老的一条，追加新的
    const next = prev.slice(-(TEAMMATE_MESSAGES_UI_CAP - 1))
    next.push(item)
    return next
  }
  return [...prev, item]
}
```

这个函数实现了一个**滑动窗口**：AppState 里的 `messages` 数组始终不超过 50 条，新消息进来时最老的消息被移出。完整的会话历史存在：
1. `inProcessRunner.ts` 里的 `allMessages` 局部变量（完整历史，但随 Agent 生命周期结束而释放）
2. 磁盘上的 JSONL sidechain（永久持久化）

UI 显示只需要最近 50 条，足够让用户了解 Teammate 当前在做什么。

---

## 七、Swarm 的完整交互模型

把所有部分串起来，一个 Swarm 会话的完整流程是这样的：

```
用户：创建一个团队，让 researcher 和 coder 并行工作

主 Agent（Leader）
│
├─ AgentTool({name: 'researcher', team_name: 'team1', prompt: '研究 API 设计'})
│   → spawnTeammate()
│   → runWithTeammateContext(researcherIdentity, runAgent(...))
│   → 状态存入 AppState.tasks['researcher@team1']
│   → 返回 { status: 'teammate_spawned', tmux_window_name: 'researcher', ... }
│
├─ AgentTool({name: 'coder', team_name: 'team1', prompt: '实现用户管理'})
│   → spawnTeammate()
│   → runWithTeammateContext(coderIdentity, runAgent(...))
│   → 状态存入 AppState.tasks['coder@team1']
│
│   [两个 Teammate 并行运行]
│
│   researcher 完成 API 研究后：
│   → writeToMailbox('coder@team1', '发现 REST API 规范文档在 docs/api.md')
│   → sendIdleNotification('leader')
│
│   coder 读到邮箱消息，继续实现
│
│   coder 遇到权限请求（需要 git commit）：
│   → 通过 LeaderPermissionBridge 推入 Leader 的 ToolUseConfirm 队列
│   → UI 显示 "[coder@team1] wants to: git commit -m '...'"
│   → 用户批准 → coder 继续
│
│   两个 Teammate 都完成（isIdle = true）：
│   → onIdleCallbacks 触发
│   → Leader 收到通知，汇总结果
│
└─ 向用户展示团队工作成果
```

---

## 八、Swarm 与传统多 Agent 的根本区别

| 维度 | 普通 AgentTool 子 Agent | Swarm Teammate |
|------|------------------------|----------------|
| 隔离机制 | 独立 ToolUseContext | AsyncLocalStorage + 独立 ToolUseContext |
| 通信 | 工具返回值（单向） | Mailbox（双向） |
| 身份感知 | 无（子 Agent 不知道自己是谁） | 有（`isTeammate()`, `getTeammateContext()` |
| 权限确认 | 自动拒绝（后台）/ 自动同意 | 通过 Leader UI 显示（用户可见） |
| 长期运行 | 完成任务即终止 | 可保持 idle 状态，等待新任务 |
| Plan 模式 | 不支持 | 支持（`awaitingPlanApproval`） |
| UI 显示 | 背景任务 pill | 独立面板（彩色标识） |

---

## 本节小结

Swarm 模式（`InProcessTeammate`）是 Claude Code 最高级的多 Agent 协作模式。它用 `AsyncLocalStorage` 在同进程内实现身份隔离，用邮箱系统实现 Teammate 间的双向通信，用 Leader Permission Bridge 让后台 Teammate 的权限请求能通过 Leader 的 UI 到达用户。`TEAMMATE_MESSAGES_UI_CAP=50` 的设计来自生产数据（292 Agent 会话达到 36.8GB），用滑动窗口解决了内存压力。

## 第 14 章总结

多 Agent 系统的核心是隔离与通信：
- **隔离**：每个 Agent 有独立的 ToolUseContext，其中 readFileState 深拷贝、UI 回调 no-op、AbortController 亲子关系
- **通信**：工具返回值（同步）、task-notification（异步）、邮箱（双向，Swarm 专用）
- **Cache 共享**：Fork 模式通过相同前缀共享 prompt cache，大幅节省 token 开销
- **安全**：递归守卫（querySource 检查 + 消息历史扫描）防止无限嵌套

## 下一章预告

第 14 章覆盖了多 Agent 的技术实现。下一章进入记忆系统：Claude Code 是如何在会话之间"记住"事情的？MEMORY.md 文件如何被读取、存储、注入系统提示？

➡️ [下一节：15-1 为什么需要记忆系统？](./15-1-为什么需要记忆系统.md)
