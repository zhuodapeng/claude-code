# 4-4 外部状态存储：为什么 Claude Code 不用 useState

> **本节目标**：理解 Claude Code 状态管理的设计思路——为什么不用 `useState`（或 Redux、Zustand），而是自己实现了一个极简的外部状态存储。这个决策背后有一个根本性的架构原因。

---

## 先理解 `useState` 的正常工作方式

在普通 React Web 应用里，状态（`useState`）由 React 组件拥有，生命周期和组件绑定：

```typescript
function ChatApp() {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  
  async function sendMessage(text: string) {
    setLoading(true)
    const response = await callAPI(text)
    setMessages(prev => [...prev, response])
    setLoading(false)
  }
  
  return <MessageList messages={messages} loading={loading} />
}
```

这很自然：**状态在 React 树里，操作状态的函数也在 React 树里**。

---

## Claude Code 的问题：状态操作来自 React 树外部

Claude Code 的架构是这样的：

```
                queryLoop（AsyncGenerator）
                        │
                   yield 事件
                        │
                        ▼
              QueryEngine（非 React 代码）
                        │
              处理事件，更新对话历史
                        │
                        ▼
              ??? 怎么通知 React 重新渲染 ???
                        │
                        ▼
                   Ink TUI（React 树）
```

`queryLoop` 是一个 AsyncGenerator 函数，不是 React 组件。`QueryEngine` 是一个普通类，也不是 React 组件。

**但它们需要驱动 TUI 更新**——每收到一个流式 token，TUI 就要刷新显示。

如果状态在 `useState` 里，`queryLoop` 怎么调用 `setMessages`？

**它拿不到！** `useState` 的 setter 只在 React 渲染周期内可访问，无法从 React 树外部调用。

---

## 朴素方案：把 setter 传出去

一个想法：把 `setMessages` 通过 props 或 context 传给 `QueryEngine`？

```typescript
// ❌ 这种方式有严重问题
function App() {
  const [messages, setMessages] = useState([])
  
  // 创建 QueryEngine 时把 setter 传进去
  const engine = new QueryEngine({ onUpdate: setMessages })
  
  return <Chat messages={messages} engine={engine} />
}
```

**问题一：`useState` 的 setter 是"闭包捕获"的**

`setMessages` 是闭包，捕获了当前渲染时刻的 `messages` 值。下次渲染时，`setMessages` 引用更新了，但 `QueryEngine` 还持有旧的引用。这会导致状态更新丢失。

**问题二：组件卸载/重挂**

React 可能卸载并重新挂载组件（比如 React 18 的严格模式），这时 `useState` 会被重置。但 `QueryEngine` 里还有对话历史，状态不一致了。

**问题三：多个消费者**

Claude Code 的 TUI 是一个大的组件树，多个地方需要读取同一份数据。`useState` 只在一个组件里，其他组件需要通过 props 层层传递，很繁琐。

---

## 真正的解法：外部状态存储

解决这个问题的正确方式是：**把状态放在 React 树外部，组件通过订阅的方式获取数据**。

这个模式叫 **"外部状态存储（External Store）"**。

Claude Code 自己实现了一个极简的外部存储，代码只有 35 行：

**文件：[src/state/store.ts](../src/state/store.ts#L1-L34)**

```typescript
type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

export type Store<T> = {
  getState: () => T                           // 读取当前状态
  setState: (updater: (prev: T) => T) => void // 更新状态
  subscribe: (listener: Listener) => () => void // 订阅变化
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    // 直接返回当前状态（同步，不是 React 状态）
    getState: () => state,

    setState: (updater) => {
      const prev = state
      const next = updater(prev)
      
      // 性能优化：如果值没变（引用相等），不触发更新
      if (Object.is(next, prev)) return
      
      state = next
      onChange?.({ newState: next, oldState: prev })
      
      // 通知所有订阅者（通常是 React 的重渲染触发器）
      for (const listener of listeners) listener()
    },

    // 订阅变化，返回取消订阅函数
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)   // 返回清理函数
    },
  }
}
```

这个 `createStore` 实现了一个经典的**发布-订阅（Pub/Sub）模式**：
- 任何代码都能调用 `store.setState(...)` 来更新状态（包括 React 树外部的代码）
- 每次更新会通知所有订阅者（React 组件通过 `useSyncExternalStore` 订阅）

---

## 外部存储 vs React 状态的关键区别

```
               React useState              外部 Store（store.ts）
               
状态住在哪里：   React 组件内部              React 树外部（模块级变量）
谁能更新：       只有 React 组件             任何代码（包括 QueryEngine）
生命周期：       和组件绑定                  独立，跨越组件挂载/卸载
多组件共享：     要 prop drilling 或 Context  所有组件都能直接订阅
组件卸载后：     状态丢失                    状态保留
```

Claude Code 的 `QueryEngine` 持有 `store.setState` 的引用：

```typescript
// src/QueryEngine.ts（简化）
class QueryEngine {
  constructor(config: { setAppState: (f: (prev: AppState) => AppState) => void }) {
    this.setAppState = config.setAppState   // 这是 store.setState
  }
  
  // 收到新 token 时调用
  private onNewToken(token: string) {
    this.setAppState(prev => ({
      ...prev,
      currentResponse: prev.currentResponse + token
    }))
    // ↑ 这直接触发了 React 重新渲染，即使 QueryEngine 不在 React 树里
  }
}
```

---

## 为什么不用 Redux 或 Zustand？

你可能知道 Redux 或 Zustand 这类状态管理库，它们也是"外部存储"模式。为什么 Claude Code 不用？

**理由一：这个存储的需求极其简单**

Claude Code 只需要：
- 一个状态对象
- 更新它
- 订阅变化

35 行代码就够了，不需要引入 Redux 的 action/reducer/dispatch 体系。

**理由二：控制依赖**

引入第三方状态库会带来版本兼容性问题、API 变化风险。自己写 35 行代码，完全可控。

**理由三：和 `useSyncExternalStore` 配合**

React 18 专门提供了 `useSyncExternalStore` Hook，设计上就是为了连接这类"外部存储"。下一节会专门讲这个 Hook。

---

## 整体架构：状态如何流动

```
┌──────────────────────────────────────────────────────┐
│                        Store                          │
│    state: AppState                                    │
│    getState() / setState() / subscribe()              │
└──────┬───────────────────────────────────────┬────────┘
       │ setState()（写）                        │ subscribe()（订阅）
       │                                        │
       ▼                                        ▼
┌─────────────────┐                   ┌──────────────────────┐
│   QueryEngine   │                   │    React 组件树        │
│  （非 React）   │                   │                      │
│                 │                   │  useSyncExternalStore │
│  queryLoop 产出 │                   │  ← 自动订阅           │
│  事件时更新状态  │                   │  ← 状态变化时重渲染    │
└─────────────────┘                   └──────────────────────┘
```

**数据流向**：
- `queryLoop` 产出事件 → `QueryEngine` 处理 → `store.setState()` 更新
- Store 通知订阅者 → React 检测到外部存储变化 → 重渲染组件

这是一个**单向数据流**，清晰、可预测。

---

## 本节小结

- Claude Code 的状态更新来自 React 树外部（`QueryEngine`、`queryLoop`），不能用 `useState`
- 解法是"外部存储"模式：状态放在 React 树之外的模块变量里
- `createStore` 只有 35 行，实现 `getState/setState/subscribe`
- `setState` 更新状态后通知所有订阅者（React 组件）
- 没有用 Redux/Zustand 是因为需求简单、自己写更可控
- React 18 的 `useSyncExternalStore` 是连接外部存储的官方方式（下节讲）

## 前后呼应

- 本节的 `createStore` 实现，在 **[12-2 节](./12-2-订阅发布模式createStore.md)** 会深入分析其设计权衡
- 本节说的"QueryEngine 调用 store.setState"，在 **[10-2 节](./10-2-消息历史的生命周期.md)** 会看到消息历史更新的完整链路

## 下一节预告

下一节讲 **`useSyncExternalStore`**——React 18 官方提供的 Hook，专门用来订阅外部存储，解决并发渲染下的撕裂问题。

➡️ [下一节：4-5 useSyncExternalStore：React 18 的状态同步新方式](./4-5-useSyncExternalStore.md)
