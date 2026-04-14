# 4-5 useSyncExternalStore：React 18 的状态同步新方式

> **本节目标**：深入理解 `useSyncExternalStore` 这个 React Hook——它为什么存在、如何使用、解决了什么问题，以及 Claude Code 如何用它连接外部存储和 React 组件树。这是整个状态管理架构的最后一块拼图。

---

## 复习：外部存储的问题

上一节我们设计了 `createStore`，可以在 React 树外部管理状态。但现在 React 组件怎么"订阅"这个外部存储？

朴素方案：

```typescript
function MyComponent() {
  const [appState, setAppState] = useState(() => store.getState())
  
  useEffect(() => {
    // 订阅 store 变化，变化时用 setState 触发重渲染
    const unsubscribe = store.subscribe(() => {
      setAppState(store.getState())
    })
    return unsubscribe  // 组件卸载时取消订阅
  }, [])
  
  return <Text>{appState.currentMessage}</Text>
}
```

这能工作，但有一个**严重问题**：在 React 18 的并发模式下，这种写法可能导致**"撕裂（Tearing）"**。

---

## React 18 并发模式和撕裂问题

React 18 引入了并发特性：渲染可以被**中断和恢复**。这意味着一次渲染可能：
1. 开始渲染组件 A，读取外部存储，值是 "hello"
2. 渲染被中断（比如有更高优先级的更新）
3. 外部存储被更新，值变成了 "world"
4. 渲染恢复，渲染组件 B，读取外部存储，值是 "world"

**结果**：同一次渲染里，A 看到 "hello"，B 看到 "world"——**同一个数据在同一帧里有两个不同的值**，这就是"撕裂"。

视觉效果：界面显示不一致，比如左边显示"已登录"，右边显示"未登录"。

---

## `useSyncExternalStore`：React 18 的官方解法

React 18 专门提供了 `useSyncExternalStore` Hook 来安全地订阅外部存储：

```typescript
import { useSyncExternalStore } from 'react'

const value = useSyncExternalStore(
  subscribe,      // 参数1：订阅函数
  getSnapshot,    // 参数2：获取当前快照
  getServerSnapshot  // 参数3（可选）：SSR 服务端快照
)
```

**三个参数的作用**：

- **`subscribe(callback)`**：在外部存储变化时调用 `callback`，React 收到通知后重渲染
- **`getSnapshot()`**：获取当前状态的"快照"（同步函数，不能异步）
- **返回值**：快照的当前值，每次存储变化时自动更新

**为什么能解决撕裂？**

`useSyncExternalStore` 保证同一次渲染里，所有使用同一个存储的组件都读取到**相同时刻的快照**。React 内部会在提交阶段再次检查快照是否一致，如果不一致会强制同步重渲染。

---

## 在 Claude Code 里的应用

### 示例一：命令队列订阅

**文件：[src/hooks/useCommandQueue.ts](../src/hooks/useCommandQueue.ts#L1-L15)**

```typescript
import { useSyncExternalStore } from 'react'
import {
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from '../utils/messageQueueManager.js'

/**
 * React hook to subscribe to the unified command queue.
 * Returns a frozen array that only changes reference on mutation.
 * Components re-render only when the queue changes.
 */
export function useCommandQueue(): readonly QueuedCommand[] {
  return useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)
}
```

这里 `subscribeToCommandQueue` 和 `getCommandQueueSnapshot` 来自外部模块（`messageQueueManager.js`），是标准的发布-订阅对：
- `subscribeToCommandQueue`：注册监听器，返回取消订阅函数
- `getCommandQueueSnapshot`：返回当前命令队列的快照

### 示例二：连接 AppState Store

Claude Code 的主要状态（`AppState`）也通过 `useSyncExternalStore` 连接：

```typescript
// 组件里使用
function useAppState() {
  const store = useContext(AppStoreContext)
  return useSyncExternalStore(
    store.subscribe,
    store.getState,
  )
}
```

`AppStoreContext` 提供了 `createStore` 创建的 Store 对象，`useSyncExternalStore` 用 `store.subscribe` 和 `store.getState` 订阅它。

---

## 深入理解：`useSyncExternalStore` 的保证

`useSyncExternalStore` 给你三个保证：

**保证1：快照稳定性**

`getSnapshot()` 如果返回同一个对象引用，React 不会重渲染。所以 `store.getState()` 要遵循"如果状态没变，返回同一个引用"的原则。

在 [src/state/store.ts](../src/state/store.ts#L22-L24) 里：

```typescript
setState: (updater) => {
  const next = updater(prev)
  if (Object.is(next, prev)) return  // 引用相同就不更新，不触发重渲染
  // ...
}
```

这个 `Object.is` 检查确保了：如果更新函数返回相同的对象引用，`useSyncExternalStore` 不会触发不必要的重渲染。

**保证2：并发安全**

即使在 React 18 并发模式下，同一次渲染里所有用到这个存储的组件都读到相同的快照。

**保证3：严格模式兼容**

React 严格模式会故意调用函数两次，`useSyncExternalStore` 能正确处理这种情况。

---

## 整个状态系统的完整图景

现在把第 4 章的所有内容串联起来：

```
queryLoop（AsyncGenerator）
        │  yield StreamEvent
        ▼
QueryEngine（非 React 类）
        │  store.setState(...)  ← 直接调用，没有 React 约束
        ▼
┌─────────────────────────────────┐
│       createStore（store.ts）   │
│  state: AppState                │
│  listeners: Set<() => void>     │
└────────────┬────────────────────┘
             │  通知所有订阅者
             ▼
┌─────────────────────────────────────────────────────┐
│              useSyncExternalStore（React Hook）       │
│                                                     │
│  subscribe = store.subscribe                        │
│  getSnapshot = store.getState                       │
│                                                     │
│  → React 订阅了外部存储                              │
│  → 存储变化时，React 重渲染相关组件                   │
└────────────────────────────────┬────────────────────┘
                                 │  触发重渲染
                                 ▼
                          Ink TUI（React 组件树）
                                 │
                                 ▼
                           终端字符更新
```

这个架构实现了：
1. **解耦**：`QueryEngine` 不需要知道 React 的存在，只需要调用 `setState`
2. **响应式**：每次状态变化，TUI 自动更新，不需要手动通知
3. **并发安全**：`useSyncExternalStore` 防止渲染撕裂
4. **性能**：只有用到变化部分的组件会重渲染（由 `Object.is` 保证）

---

## 类比理解：这和 Redux 很像

如果你接触过 Redux：

| Redux | Claude Code |
|-------|------------|
| Redux Store | `createStore()` 返回的 Store |
| `dispatch(action)` | `store.setState(updater)` |
| `store.subscribe()` | `store.subscribe()` |
| `useSelector()` | `useSyncExternalStore(store.subscribe, store.getState)` |
| Redux Devtools | - |

Claude Code 的实现是一个极简版 Redux：去掉了 action、reducer 这些中间概念，直接用函数式更新（`prev => newState`）。

---

## 本节小结

- `useSyncExternalStore(subscribe, getSnapshot)` 是 React 18 安全订阅外部存储的官方 API
- 它解决了并发模式下的"撕裂"问题——保证同一帧内所有组件读到相同快照
- 需要 `getSnapshot` 在状态不变时返回相同引用，避免不必要的重渲染
- Claude Code 的组件通过这个 Hook 订阅 `AppState` Store，实现自动重渲染
- 完整链路：`queryLoop` 产出事件 → `QueryEngine` 更新 Store → `useSyncExternalStore` 触发 React 重渲染 → Ink 更新终端

## 前后呼应

- 本章建立的"Store → useSyncExternalStore → 组件"链路，在 **[12-4 节](./12-4-实时更新流式token如何驱动TUI刷新.md)** 会看到流式 token 如何通过这条链路驱动 TUI 实时刷新
- `createStore` 在 **[12-2 节](./12-2-订阅发布模式createStore.md)** 会深入分析设计权衡

## 下一节预告

第 4 章结束了！接下来是最后一个前置知识部分：**LLM API 工作原理**。理解了 API 的工作方式，才能理解 `queryLoop` 里那些 API 调用在做什么。

➡️ [下一节：5-1 什么是 Token？Context Window 是什么意思？](./5-1-Token和上下文窗口.md)
