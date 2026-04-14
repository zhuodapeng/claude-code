# 12-2 订阅-发布模式：createStore() 是怎么工作的

> 整个 TUI 的响应性建立在一个只有 34 行的 `createStore()` 函数上。本节拆解它的三个操作（`getState`、`setState`、`subscribe`），追踪 `AppStateProvider` 如何把它注入 React，以及 `useSyncExternalStore` 如何让组件只在关心的字段变化时才重渲染。

---

## 问题引入：React 和外部状态如何同步

React 的 `useState` 是"组件内部"状态——生命周期和组件绑定，无法从 React 树外部读取或更新。

但 Claude Code 有大量"React 树外部"的代码需要更新 UI 状态：

- `query.ts` 里的 queryLoop，在收到 API 流时需要更新消息列表
- 权限系统，在用户点击"允许"时需要更新权限上下文
- Slash 命令处理器，在用户输入 `/plan` 时需要切换权限模式

这些代码不是 React 组件，拿不到 `useState` 的 setter。

**朴素方案**：用一个全局变量 + 手动触发 `forceUpdate()`。

**问题**：这就是 2013 年的 jQuery 模式——状态散落在全局，没有订阅机制，没有引用比较，任何变化都触发全量重渲染。

**真实方案**：`createStore<T>`——一个精心设计的外部状态容器，兼容 React 18 的 `useSyncExternalStore`。

---

## createStore 的完整实现

**文件：[src/state/store.ts](../src/state/store.ts)**（全文 34 行）

```typescript
type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,   // ← 可选的副作用回调，State 变化时触发
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,

    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return     // ← 关键：引用相等则跳过
      state = next
      onChange?.({ newState: next, oldState: prev })   // ← 先触发副作用
      for (const listener of listeners) listener()      // ← 再通知订阅者
    },

    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)           // ← 返回取消订阅函数
    },
  }
}
```

三个操作的语义：

| 操作 | 用途 | 调用者 |
|------|------|--------|
| `getState()` | 读取当前状态快照 | React 组件、非 React 代码 |
| `setState(updater)` | 用纯函数更新状态 | 任何需要改变状态的代码 |
| `subscribe(listener)` | 注册状态变化监听器 | `useSyncExternalStore`（通常不直接调用） |

---

## `Object.is(next, prev)` 为什么能防止无效重渲染

`setState` 里的这一行非常关键：

```typescript
if (Object.is(next, prev)) return  // 引用相等 → 什么都不做
```

`Object.is` 等价于 `===`（除了 `NaN === NaN` 和 `-0 === +0` 的边界情况）。

对象比较的是**引用**，不是内容。这意味着：

```typescript
// 更新时要创建新对象
store.setState(prev => ({
  ...prev,
  verbose: true,   // 新对象 → Object.is 返回 false → 触发重渲染 ✓
}))

// 如果写成这样（mutate 后返回同一引用）
store.setState(prev => {
  prev.verbose = true  // 直接修改
  return prev          // 同一引用 → Object.is 返回 true → 不触发重渲染 ✗
})
```

这就是为什么 `AppState` 必须是 `DeepImmutable`：TypeScript 在编译期阻止第二种写法。

---

## `onChange` 回调：副作用的统一出口

`createStore` 的第二个参数是 `onChange`。Claude Code 在创建 AppState store 时传入了 `onChangeAppState`：

**文件：[src/state/AppState.tsx](../src/state/AppState.tsx#L49-L57)**

```typescript
const [store] = useState(
  () => createStore(
    initialState ?? getDefaultAppState(),
    onChangeAppState,   // ← 每次 setState 都会调用这个
  )
)
```

`onChangeAppState` 的实现在 [src/state/onChangeAppState.ts](../src/state/onChangeAppState.ts)，它做了什么？

```typescript
export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
  // 1. 权限模式变化 → 同步到 CCR（claude.ai 桥接）和 SDK 状态流
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    notifyPermissionModeChanged(newMode)            // ← SDK 状态流
    if (prevExternal !== newExternal) {
      notifySessionMetadataChanged({ permission_mode: newExternal })  // ← CCR
    }
  }

  // 2. 模型变化 → 持久化到磁盘
  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    if (newState.mainLoopModel === null) {
      updateSettingsForSource('userSettings', { model: undefined })
    } else {
      updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
    }
    setMainLoopModelOverride(newState.mainLoopModel)
  }

  // 3. expandedView 变化 → 持久化 UI 设置
  if (newState.expandedView !== oldState.expandedView) {
    saveGlobalConfig(current => ({
      ...current,
      showExpandedTodos: newState.expandedView === 'tasks',
    }))
  }
}
```

**为什么把副作用集中在这里**，而不是分散在各个 `setAppState` 调用处？

这是"单一变更监听点"模式（代码注释里叫"single choke point"）。权限模式的改变有 8+ 个入口：Shift+Tab 快捷键、`/plan` 命令、ExitPlanMode 对话框、Bridge 的远程控制……如果每个入口都要手动通知 CCR，很容易漏掉。把监听点收到这里，任何入口改变 AppState 都自动触发。

---

## AppStateProvider：把 Store 注入 React

**文件：[src/state/AppState.tsx](../src/state/AppState.tsx#L27-L110)**

```typescript
export const AppStoreContext = React.createContext<AppStateStore | null>(null);

export function AppStateProvider({ children, initialState, onChangeAppState }) {
  // useState 的惰性初始化：createStore 只调用一次
  const [store] = useState(
    () => createStore(initialState ?? getDefaultAppState(), onChangeAppState)
  )

  // 挂载时检查：如果 Statsig 远程禁用了 bypass 模式，立刻关闭
  useEffect(() => {
    const { toolPermissionContext } = store.getState()
    if (toolPermissionContext.isBypassPermissionsModeAvailable && isBypassPermissionsModeDisabled()) {
      store.setState(prev => ({
        ...prev,
        toolPermissionContext: createDisabledBypassPermissionsContext(prev.toolPermissionContext)
      }))
    }
  }, [])

  // 监听外部设置文件变化（用户在磁盘上修改了配置）
  useSettingsChange(source => applySettingsChange(source, store.setState))

  // 把 store 放入 Context，子树所有组件都可以读取
  return (
    <AppStoreContext.Provider value={store}>
      {children}
    </AppStoreContext.Provider>
  )
}
```

`AppStateProvider` 是整个 React 树的根组件之一。它的位置在 `src/main.tsx` 的渲染树顶部，确保所有 TUI 组件都在它的 Context 范围内。

---

## useAppState：精确订阅

**文件：[src/state/AppState.tsx](../src/state/AppState.tsx#L142-L163)**

```typescript
export function useAppState(selector) {
  const store = useAppStore()  // 从 Context 拿 store
  
  const get = () => {
    const state = store.getState()
    return selector(state)    // 只取你关心的那一块
  }
  
  // React 18 的外部状态同步 hook
  return useSyncExternalStore(store.subscribe, get, get)
}
```

`useSyncExternalStore` 是 React 18 专为外部状态同步设计的 hook，签名是：

```
useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot?)
```

它做了什么：
1. 调用 `subscribe(callback)` 注册监听器
2. 调用 `getSnapshot()` 读取当前快照
3. 当 `store.setState` 触发 `listener()` 时，React 重新调用 `getSnapshot()`
4. 用 `Object.is` 比较新旧快照：**不同才重渲染**

这就是精确订阅的关键——`selector` 函数决定了"我关心哪些字段"：

```typescript
// REPL.tsx 里的用法
const toolPermissionContext = useAppState(s => s.toolPermissionContext)
// ↑ 只有 toolPermissionContext 引用变化时，这个组件才重渲染

const verbose = useAppState(s => s.verbose)
// ↑ 只有 verbose 变化时，这个组件才重渲染

const tasks = useAppState(s => s.tasks)
// ↑ 只有 tasks 对象引用变化时，才重渲染
```

**注意**：`selector` 不能返回新对象：

```typescript
// 错误用法 ✗
const { text } = useAppState(s => ({ text: s.promptSuggestion.text }))
// 每次调用都返回新对象 → Object.is 永远不等 → 无限重渲染

// 正确用法 ✓
const promptSuggestion = useAppState(s => s.promptSuggestion)
const { text } = promptSuggestion
```

---

## useSetAppState：写状态而不订阅

有时组件只需要写入状态，不需要读取。例如一个提交按钮，点击时更新状态，但不需要在状态变化时重渲染。

```typescript
export function useSetAppState() {
  return useAppStore().setState
}
```

这个 hook 返回 `store.setState`，但**不调用 `useSyncExternalStore`**，因此组件不会因为 AppState 变化而重渲染。

```typescript
// REPL.tsx 的用法
const setAppState = useSetAppState()

// 后面某处
setAppState(prev => ({
  ...prev,
  toolPermissionContext: { ...prev.toolPermissionContext, mode: 'plan' }
}))
```

---

## 整个订阅-发布流程

```
非 React 代码（query loop、权限系统、命令处理器）
        │
        │ store.setState(prev => ({...prev, spinnerTip: '正在思考'}))
        ▼
createStore.setState()
  ├── Object.is(next, prev)? → 相等则 return（不触发）
  ├── state = next（更新内部快照）
  ├── onChange({newState, oldState}) → onChangeAppState() 副作用
  └── for (const listener of listeners) listener()  ← 通知所有 React 订阅者
        │
        ▼
useSyncExternalStore 的内部机制
  ├── 调用 getSnapshot()  → selector(state)
  ├── Object.is(newSnapshot, oldSnapshot)?
  │     相等 → 不重渲染
  │     不等 → 触发 React 重渲染
        │
        ▼
组件重渲染，显示最新状态
```

---

## 本节小结

`createStore<T>` 是 34 行代码实现的外部状态容器。核心设计是：`Object.is` 防止无效重渲染；`onChange` 回调集中处理副作用；`subscribe` 与 `useSyncExternalStore` 配合实现 React 感知。`AppStateProvider` 在 React 树顶部创建一个 store 实例，`useAppState(selector)` 让每个组件只订阅自己关心的字段，`useSetAppState()` 让只写组件不触发额外订阅。

## 前后呼应

- `onChangeAppState` 里用到的权限模式同步逻辑，在 **[11-6 节](./11-6-bypassPermissions与安全底线.md)** 讲过"为什么要统一到一个地方"
- 本节的 `useSyncExternalStore` 在 **[4-5 节](./4-5-useSyncExternalStore.md)** 有理论背景，这里是实际用法

## 下一节预告

Store 机制解决了"状态如何驱动 React 重渲染"。但消息列表（Claude 的输出、用户的输入）并不放在 AppState 里——它有一套独立的存储和渲染机制。下一节看消息流从 query loop 到终端显示的完整路径。

➡️ [下一节：12-3 消息流的渲染：从 SDKMessage 到终端显示](./12-3-消息流的渲染.md)
