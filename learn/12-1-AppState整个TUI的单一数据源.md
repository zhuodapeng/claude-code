# 12-1 AppState：整个 TUI 的单一数据源

> Claude Code 的 TUI 界面背后有两套截然不同的状态：一套是进程级别的全局单例，另一套是驱动 React 重渲染的 UI 状态。本节追踪这两套状态的具体位置、字段结构，以及为什么要把它们分开。

---

## 问题引入：为什么状态这么难管？

一个 AI Agent CLI 运行时需要追踪的信息非常多：

- 当前工作目录、会话 ID、API 调用耗时、Token 用量
- 权限模式、工具列表、MCP 连接状态
- TUI 展示状态：是否在加载、消息列表、spinner 类型
- 桥接状态：是否连接 claude.ai、WebSocket 是否在线

如果把这些全塞进一个 React `useState`，会怎样？

问题：React 的重渲染是批量的、有延迟的。进程级别的统计数据（API 耗时、Token 计数）没必要触发 TUI 重渲染。但如果不放在 React 状态里，非 React 代码又没法轻松读取。

**解法：Claude Code 用了两套独立的状态，各司其职。**

---

## 两套状态的分工

### Tier 1：进程级全局单例 `STATE`

**文件：[src/bootstrap/state.ts](../src/bootstrap/state.ts#L45-L257)**

```typescript
// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE
// ↑ 三条大写注释警告——这是整个代码库里最重要的注释之一

type State = {
  originalCwd: string       // 启动时的工作目录，不随 cd 改变
  projectRoot: string       // 稳定的项目根，子 Agent worktree 也不改变
  totalCostUSD: number      // 累计 API 花费
  totalAPIDuration: number  // 累计 API 等待时长
  sessionId: SessionId      // 当前会话 UUID
  // ... 100+ 个字段
}
```

这套状态的特点：
- **普通可变 JS 对象**，直接读写字段
- **进程全局单例**：`const STATE: State = getInitialState()`（[第 429 行](../src/bootstrap/state.ts#L429)）
- **不触发任何 React 重渲染**
- 主要存放：统计数据、缓存、遥测、会话标识

访问方式全部通过导出函数，例如：

```typescript
export function getSessionId(): SessionId {
  return STATE.sessionId
}

export function getCwdState(): string {
  return STATE.cwd
}

export function addToTotalDurationState(
  duration: number,
  durationWithoutRetries: number,
): void {
  STATE.totalAPIDuration += duration      // 直接 += 不用 setState
  STATE.totalAPIDurationWithoutRetries += durationWithoutRetries
}
```

为什么不让外部代码直接访问 `STATE`？接口封装。`state.ts` 是整个 import DAG 的叶节点（不依赖任何业务代码），其他模块通过函数来与它交互，避免循环依赖。

---

### Tier 2：React 驱动的 `AppState`

**文件：[src/state/AppStateStore.ts](../src/state/AppStateStore.ts#L89-L454)**

```typescript
export type AppState = DeepImmutable<{
  settings: SettingsJson           // 所有用户设置
  verbose: boolean                 // --verbose flag
  mainLoopModel: ModelSetting      // 当前使用的模型
  toolPermissionContext: ToolPermissionContext  // 权限上下文快照
  spinnerTip?: string              // spinner 文字提示
  expandedView: 'none' | 'tasks' | 'teammates'  // 展开哪个面板
  replBridgeEnabled: boolean       // 是否开启 claude.ai 桥接
  // ... 60+ 个字段
}> & {
  // 排除在 DeepImmutable 之外（因为包含函数类型）
  tasks: { [taskId: string]: TaskState }
  mcp: { clients: MCPServerConnection[]; tools: Tool[]; ... }
  inbox: { messages: Array<...> }
}
```

这套状态的特点：
- **`DeepImmutable<T>`**：所有嵌套字段都是 `readonly`，不能直接改
- **通过 `createStore<AppState>`** 包装（下一节详解）
- **任何 `setState` 调用都可能触发 React 重渲染**
- 主要存放：直接影响 TUI 显示的状态

---

## `DeepImmutable` 的用意

```typescript
export type AppState = DeepImmutable<{
  verbose: boolean
  settings: SettingsJson
  // ...
}>
```

`DeepImmutable<T>` 把所有字段递归变成 `readonly`。这不只是 TypeScript 语法糖——它是架构约束：

**强制"状态只能替换，不能修改"**。更新 AppState 的唯一方式是：

```typescript
store.setState(prev => ({
  ...prev,              // 复制所有字段
  verbose: true,        // 替换其中一个
}))
```

而不是：
```typescript
appState.verbose = true  // TypeScript 报错：Cannot assign to 'verbose' because it is a read-only property
```

这个约束确保了 React 能通过引用比较（`Object.is`）来判断是否需要重渲染。如果状态可以直接 mutate，React 就看不到变化了。

---

## `getDefaultAppState()` 的初始化

**文件：[src/state/AppStateStore.ts](../src/state/AppStateStore.ts#L456-L569)**

```typescript
export function getDefaultAppState(): AppState {
  // 处理 teammate 的初始权限模式
  const initialMode: PermissionMode =
    teammateUtils.isTeammate() && teammateUtils.isPlanModeRequired()
      ? 'plan'
      : 'default'

  return {
    settings: getInitialSettings(),   // 从磁盘加载用户设置
    tasks: {},                         // 空任务表
    agentNameRegistry: new Map(),      // 空的 Agent 名称注册表
    verbose: false,
    mainLoopModel: null,               // null = 使用默认模型
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: initialMode,               // default 或 plan（teammate 场景）
    },
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    // ... 所有其他字段初始化为空/默认值
  }
}
```

注意 `mainLoopModel: null`——`null` 代表"使用默认模型"，和空字符串或 `undefined` 语义不同。这是代码里常见的三值语义：`null`（明确的默认）/ `undefined`（未设置）/ 具体值。

---

## 两套状态的边界在哪里

一个直觉上的问题：`totalCostUSD` 放在 `STATE` 里，但费用显示在 TUI 的底部——不是应该放在 `AppState` 吗？

答案：`totalCostUSD` 是在 `cost-tracker.ts` 里聚合的，TUI 底部通过 `getTotalCost()` 直接读 `STATE`，而不是订阅 React 状态。这样 API 调用过程中每次 token 产生的费用增量不会触发 React 重渲染（那太频繁了），只在对话轮次结束时统一刷新 UI。

划分规则（非正式）：
- **需要驱动 TUI 立刻重渲染** → `AppState`
- **进程生命周期数据、累计统计、缓存** → `STATE`
- **有明确 UI 触发点的才放 AppState**（如 `spinnerTip`、`replBridgeConnected`）

---

## `createSignal` 的补充角色

除了这两套状态，还有 [src/utils/signal.ts](../src/utils/signal.ts) 里的 `createSignal`：

```typescript
export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) { ... },
    emit(...args) { for (const listener of listeners) listener(...args) },
    clear() { listeners.clear() },
  }
}
```

`Signal` 和 `Store` 的区别：
- `Signal`：纯事件通知，**没有状态快照**，订阅者只知道"事件发生了"
- `Store`：**有状态快照**（`getState()`），订阅者能读取当前值

`bootstrap/state.ts` 里的 `sessionSwitched` 就是一个 `Signal`：

```typescript
const sessionSwitched = createSignal<[id: SessionId]>()

export function switchSession(sessionId: SessionId, projectDir: string | null = null): void {
  STATE.sessionId = sessionId         // 直接修改进程状态
  STATE.sessionProjectDir = projectDir
  sessionSwitched.emit(sessionId)     // 通知所有监听者
}
```

三种状态原语各有用场：
- `State`（Tier 1）：进程级、可变、直读直写
- `Store<AppState>`（Tier 2）：React 驱动、不可变替换、订阅重渲
- `Signal`：纯事件，无状态

---

## 架构全图

```
                    进程全局
     ┌──────────────────────────────────────────────┐
     │  bootstrap/state.ts                          │
     │  const STATE: State = getInitialState()      │
     │  ─────────────────────────────               │
     │  totalCostUSD, sessionId, cwd,               │
     │  totalAPIDuration, agentColorMap...           │
     │  读写：直接函数调用（getCwdState/setCwd）     │
     └──────────────────────────────────────────────┘

                    React 驱动
     ┌──────────────────────────────────────────────┐
     │  state/AppStateStore.ts                      │
     │  AppState (DeepImmutable)                    │
     │  ─────────────────────────                   │
     │  settings, toolPermissionContext,            │
     │  tasks, mcp, verbose, spinnerTip...          │
     │  读：store.getState()                        │
     │  写：store.setState(prev => ({...prev, ...}))│
     └──────────────────────────────────────────────┘
              │                    │
         subscribe             getState
              │                    │
     ┌────────┴──────────────────────────┐
     │  useSyncExternalStore             │
     │  → React 组件重渲染               │
     └───────────────────────────────────┘
```

---

## 本节小结

Claude Code 用两套状态分离关注点：进程级的 `STATE`（可变单例，不触发 React）负责统计和缓存；`AppState`（`DeepImmutable`，通过 `Store` 包装）负责驱动 TUI。`getDefaultAppState()` 在启动时建立完整的初始快照，`DeepImmutable` 约束强制"替换而非修改"语义，这是 React 引用比较能工作的前提。

## 前后呼应

- `ToolPermissionContext` 在 `AppState` 里的位置，在 **[11-2 节](./11-2-权限规则的数据结构.md)** 已经详细讲过
- `bootstrap/state.ts` 里的 `isBypassPermissionsModeAvailable` 字段，在 **[11-6 节](./11-6-bypassPermissions与安全底线.md)** 讲过"启动时冻结"

## 下一节预告

`AppState` 通过一个 `Store` 包装。这个 `Store` 只有 34 行代码，却是整个订阅-发布机制的核心。下一节拆解 `createStore()` 的实现，以及 React 如何通过 `useSyncExternalStore` 接入它。

➡️ [下一节：12-2 订阅-发布模式：createStore() 是怎么工作的](./12-2-订阅发布模式createStore.md)
