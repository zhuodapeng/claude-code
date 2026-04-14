# 14-3 子 Agent 的隔离：独立 Context 窗口

## 问题引入：什么叫"独立 Context 窗口"？

当我们说"子 Agent 有独立的 Context 窗口"，具体是指什么？

在 Claude Code 里，一个 Agent 实例的全部运行状态都装在一个叫 `ToolUseContext` 的对象里：它记录着这个 Agent 读过哪些文件（`readFileState`）、可以用哪些工具（`options.tools`）、如何向 UI 报告状态（`setAppState`）、被谁中止（`abortController`）……

如果父子 Agent 直接**共享**同一个 `ToolUseContext`，会发生什么？

- 子 Agent 修改了 `readFileState`（记录读了某个文件），父 Agent 也看到了，下次做判断时会误以为自己已经读过这个文件
- 子 Agent 调用 `setAppState` 更新 UI，父 Agent 的 UI 状态也被意外改动
- 子 Agent 调用 `abortController.abort()` 取消自己的任务，父 Agent 也被意外取消了

所以，"独立 Context 窗口"的本质是：**创建一个隔离的 `ToolUseContext` 副本，防止子 Agent 的副作用污染父 Agent 的状态**。

这个隔离操作由 [`createSubagentContext()`](../src/utils/forkedAgent.ts#L345) 完成。

---

## createSubagentContext() 的完整源码解读

**文件：[src/utils/forkedAgent.ts](../src/utils/forkedAgent.ts#L345-L462)**

```typescript
export function createSubagentContext(
  parentContext: ToolUseContext,
  overrides?: SubagentContextOverrides,  // 调用方可以覆盖某些字段
): ToolUseContext {
  // ...
}
```

这个函数的设计原则非常清晰：**默认完全隔离，需要共享则显式选择（opt-in）**。让我们逐块看它到底隔离了什么。

---

### 第一块：AbortController 的亲子关系

**文件：[src/utils/forkedAgent.ts](../src/utils/forkedAgent.ts#L349-L354)**

```typescript
const abortController =
  overrides?.abortController ??
  (overrides?.shareAbortController
    ? parentContext.abortController   // 显式选择：共享父的
    : createChildAbortController(parentContext.abortController))  // 默认：创建子控制器
```

**不是独立的，也不是完全共享的——而是"亲子关系"。**

`createChildAbortController(parent)` 创建的控制器有这样的行为：
- 父 abort → 子也 abort（父取消，子跟着取消）
- 子 abort → 父不受影响（子取消，父继续运行）

这个设计非常合理：用户按 Ctrl+C 或取消主 Agent 时，所有子 Agent 也应该停止；但子 Agent 内部出错自我终止，不应该影响父 Agent 继续工作。

**例外**：当 `shareAbortController: true` 时，子 Agent 和父 Agent 共享完全相同的控制器。这用于 Teammate 模式——同进程 Teammate 的中止应该和主线程完全同步。

---

### 第二块：权限守卫的默认策略

**文件：[src/utils/forkedAgent.ts](../src/utils/forkedAgent.ts#L356-L374)**

```typescript
const getAppState: ToolUseContext['getAppState'] =
  overrides?.shareAbortController
    ? parentContext.getAppState  // 交互式 Agent：可以弹出权限确认框
    : () => {
        const state = parentContext.getAppState()
        // 已经设置过了就不重复
        if (state.toolPermissionContext.shouldAvoidPermissionPrompts) {
          return state
        }
        return {
          ...state,
          toolPermissionContext: {
            ...state.toolPermissionContext,
            shouldAvoidPermissionPrompts: true,  // ← 默认设置这个标志
          },
        }
      }
```

`shouldAvoidPermissionPrompts: true` 是一个关键标志，它告诉权限系统：**遇到需要确认的操作，直接拒绝，不要弹 UI**。

为什么默认拒绝而不是等待？

想象一个异步后台子 Agent 在运行，用户已经去做别的事了。如果这时候子 Agent 遇到一个文件写入权限确认，它无法弹 UI 让用户看到，只能等待——这会导致后台任务卡死，用户不知道发生了什么。

"默认拒绝"让后台 Agent 失败得快、失败得明显，而不是无声地挂起。

**例外**：当 `shareAbortController: true`（即交互式 Agent，可以操控父 UI）时，不设这个标志，权限确认可以正常弹出。

---

### 第三块：可变状态的克隆策略

**文件：[src/utils/forkedAgent.ts](../src/utils/forkedAgent.ts#L376-L403)**

```typescript
return {
  // ① readFileState：克隆父 Agent 的文件读取缓存
  readFileState: cloneFileStateCache(
    overrides?.readFileState ?? parentContext.readFileState,
  ),

  // ② nestedMemoryAttachmentTriggers：全新的 Set
  nestedMemoryAttachmentTriggers: new Set<string>(),
  loadedNestedMemoryPaths: new Set<string>(),
  dynamicSkillDirTriggers: new Set<string>(),

  // ③ toolDecisions：undefined（不继承父 Agent 的工具决策）
  toolDecisions: undefined,

  // ④ contentReplacementState：克隆父 Agent 的内容替换状态
  contentReplacementState:
    overrides?.contentReplacementState ??
    (parentContext.contentReplacementState
      ? cloneContentReplacementState(parentContext.contentReplacementState)
      : undefined),
  // ...
}
```

**为什么 `readFileState` 要克隆而不是新建？**

如果是 Fork 子 Agent（继承父会话历史），父 Agent 消息里已经包含了读过某些文件的 tool_use 记录。克隆 `readFileState` 确保子 Agent 知道"这些文件已经在上下文里了"，不会重复读取。

对于普通子 Agent（从空历史开始），`readFileState` 是全新的，因为它没有继承任何父 Agent 的会话历史。

**为什么 `contentReplacementState` 要克隆（而不是新建）？**

代码注释解释得非常清楚（[L393-L403](../src/utils/forkedAgent.ts#L393-L403)）：

```
// Clone by default (not fresh): cache-sharing forks process parent
// messages containing parent tool_use_ids. A fresh state would see
// them as unseen and make divergent replacement decisions → wire
// prefix differs → cache miss. A clone makes identical decisions →
// cache hit.
```

`contentReplacementState` 记录"哪些工具结果已经被压缩替换过"。Fork 子 Agent 处理的父消息里包含父 Agent 的 `tool_use_id`。如果新建空状态，遇到这些 ID 时会做出不同的替换决策，导致发给 API 的消息字节不同，prompt cache 命中失败。克隆父状态确保子 Agent 做出和父 Agent 一致的决策，维持 cache 命中。

---

### 第四块：UI 回调的隔离策略

**文件：[src/utils/forkedAgent.ts](../src/utils/forkedAgent.ts#L409-L443)**

```typescript
// setAppState：默认 no-op
setAppState: overrides?.shareSetAppState
  ? parentContext.setAppState
  : () => {},   // ← 什么都不做

// setAppStateForTasks：始终指向根 AppState（不能 no-op！）
setAppStateForTasks:
  parentContext.setAppStateForTasks ?? parentContext.setAppState,

// setResponseLength：默认 no-op
setResponseLength: overrides?.shareSetResponseLength
  ? parentContext.setResponseLength
  : () => {},

// UI 控制：全部 undefined
addNotification: undefined,
setToolJSX: undefined,
setStreamMode: undefined,
```

这里有一个细微但重要的区分：`setAppState` 是 no-op，但 `setAppStateForTasks` **始终**指向根 AppState。

代码注释解释了为什么（[L414-L417](../src/utils/forkedAgent.ts#L414-L417)）：

```
// Task registration/kill must always reach the root store, even when
// setAppState is a no-op — otherwise async agents' background bash tasks
// are never registered and never killed (PPID=1 zombie).
```

子 Agent 在执行过程中可能会启动 Bash 后台任务（`LocalShellTask`）。这些 Bash 任务需要在根 AppState 里注册，否则当子 Agent 被取消时，这些孤立的 Bash 进程就成了僵尸进程（PPID=1，再也无法被杀死）。

所以 `setAppStateForTasks` 必须穿透到根 AppState，即使普通的 UI 更新被 no-op 掉了。

---

### 第五块：查询追踪链的深度递增

**文件：[src/utils/forkedAgent.ts](../src/utils/forkedAgent.ts#L451-L455)**

```typescript
queryTracking: {
  chainId: randomUUID(),  // 新链 ID（每个子 Agent 独立追踪）
  depth: (parentContext.queryTracking?.depth ?? -1) + 1,  // 深度 +1
},
```

`queryTracking.depth` 记录了这个 Agent 在多 Agent 层次里的深度：
- 主线程：depth 0
- 主线程的子 Agent：depth 1
- 子 Agent 再派生子 Agent：depth 2
- ……

这个值会被 `runForkedAgent()` 记录到 `tengu_fork_agent_query` 遥测事件里，让 Anthropic 能看到多 Agent 嵌套的实际深度分布。

`chainId` 是每个子 Agent 独立的，用于把同一条查询链里的多个 API 调用关联起来（同一子 Agent 的多轮对话共享同一个 chainId）。

---

## 图解：createSubagentContext() 的隔离边界

```
父 ToolUseContext
  ├── abortController      ──→  createChildAbortController()  ← 亲子关系
  ├── readFileState        ──→  cloneFileStateCache()          ← 深拷贝
  ├── contentReplacementState → cloneContentReplacementState() ← 深拷贝
  ├── getAppState          ──→  包装后注入 shouldAvoidPermissions ← 修改
  ├── setAppState          ──→  () => {}                       ← no-op
  ├── setAppStateForTasks  ──→  parentContext.setAppStateForTasks ← 共享！（例外）
  ├── setResponseLength    ──→  () => {}                       ← no-op
  ├── addNotification      ──→  undefined                      ← 切断
  ├── setToolJSX           ──→  undefined                      ← 切断
  ├── nestedMemoryTriggers ──→  new Set()                      ← 全新
  ├── toolDecisions        ──→  undefined                      ← 全新
  ├── queryTracking.depth  ──→  parent.depth + 1               ← 递增
  └── queryTracking.chainId──→  randomUUID()                   ← 全新

  可选共享（需要显式 opt-in）：
  ├── shareSetAppState=true     → 共享 setAppState（交互式 Agent）
  ├── shareSetResponseLength=true → 共享响应长度追踪
  └── shareAbortController=true → 完全共享中止控制器（Teammate 模式）
```

---

## runAgent() 的 AbortController 策略：同步 vs 异步

`createSubagentContext()` 是通用的隔离机制，但 `runAgent.ts` 里还有一层额外的 AbortController 处理：

**文件：[src/tools/AgentTool/runAgent.ts](../src/tools/AgentTool/runAgent.ts#L520-L528)**

```typescript
// 同步 Agent：共享父 Agent 的 AbortController
// 异步 Agent：独立的 AbortController（后台任务有自己的生命周期）
const agentAbortController = override?.abortController
  ? override.abortController
  : isAsync
    ? new AbortController()     // ← 异步：完全独立！
    : toolUseContext.abortController  // ← 同步：共享父的
```

这和 `createSubagentContext()` 里的默认策略（亲子关系）不同：

- 同步 Agent：共享父的 AbortController（父取消时子也取消，符合直觉）
- 异步 Agent：**全新的独立 AbortController**（不受父取消影响）

为什么异步 Agent 要完全独立？后台任务应该独立运行，即使用户取消了当前对话，后台任务也可能需要继续（用户用 `SendMessage` 工具查询时发现任务还在跑）。如果共享父的 AbortController，一旦父 Agent 结束，所有后台任务都会意外中止。

---

## 一次 Agent 调用的完整隔离初始化流程

把前面几节串起来，一个普通子 Agent 从"被选中"到"开始执行"的完整初始化流程是：

```
AgentTool.call() 开始
  │
  ├─ assembleToolPool()          ← 用子 Agent 自己的权限模式组装工具池
  ├─ getAgentSystemPrompt()      ← 构建子 Agent 的系统提示（含环境信息）
  ├─ createSubagentContext()     ← 创建隔离的 ToolUseContext（本节核心）
  │   ├─ 克隆 readFileState
  │   ├─ 克隆 contentReplacementState
  │   ├─ createChildAbortController（亲子关系）
  │   ├─ 注入 shouldAvoidPermissionPrompts=true
  │   ├─ setAppState → no-op
  │   ├─ setAppStateForTasks → 根 AppState（穿透）
  │   └─ queryTracking.depth +1
  │
  ├─ executeSubagentStartHooks() ← 执行 subagent_start hooks
  │
  └─ query() ← 开始子 Agent 的 query 循环（完全独立的消息历史）
```

子 Agent 从 `query()` 开始就拥有了完全独立的上下文，它的所有操作都在这个隔离的沙盒里进行，不会影响父 Agent。

---

## 本节小结

`createSubagentContext()` 是多 Agent 系统的隔离基础。它的设计原则是"默认隔离，显式共享"：可变状态（readFileState、contentReplacementState）深拷贝；UI 回调变成 no-op；AbortController 采用亲子关系；但 `setAppStateForTasks` 始终穿透到根 AppState，防止僵尸进程。`contentReplacementState` 克隆而非新建，是维持 Fork 子 Agent prompt cache 命中率的关键设计。

## 前后呼应

- `shouldAvoidPermissionPrompts` 标志与 **[11-3 节](./11-3-七步流水线逐行追踪.md)** 里的权限流水线有直接联系——它是流水线里的一个短路条件
- `queryTracking.depth` 的递增与 `runForkedAgent()` 的遥测日志相关，在 **[14-5 节](./14-5-异步后台Agent任务生命周期管理.md)** 里会看到它如何被记录

## 下一节预告

子 Agent 有三种运行环境：本地（共享文件系统）、Worktree（隔离的 git 工作树）、远程（CCR 环境）。这三种模式的技术实现各不相同，带来的能力和限制也完全不同。

➡️ [下一节：14-4 三种执行模式：本地/远程/Worktree](./14-4-三种执行模式.md)
