# 3-6 并发控制与 AbortController

> **本节目标**：理解 AbortController 是什么、为什么需要它、如何用它取消正在进行的异步操作，以及 Claude Code 如何用它在用户发新消息时中断正在执行的 AI 响应。

---

## 一个现实问题：怎么取消一个请求？

想象这个场景：

用户对 Claude 说"帮我分析整个代码库"，Claude 开始工作——发出 API 请求，开始执行工具。30 秒后，用户觉得这个任务太大了，想取消，发了一个新消息"算了，只分析主文件"。

**怎么停止正在进行的操作？**

没有取消机制的代码是这样的：

```typescript
// ❌ 没有取消机制
async function queryWithNoCancel(prompt: string) {
  const response = await fetch('/api/claude', { body: prompt })
  // 用户想取消？没办法——fetch 不理你
  
  for (const tool of response.toolCalls) {
    await executeTool(tool)
    // 每个工具都会执行完，即使用户已经"取消"了
  }
}
```

用户点"取消"，但底层操作还在跑，浪费时间、消耗 API 额度、可能产生不想要的副作用。

---

## AbortController：取消异步操作的标准方案

`AbortController` 是 Web 标准 API（Node.js/Bun 也支持），专门用于取消异步操作。

它的工作原理非常简单：

```
AbortController
    │
    ├── .signal    ← AbortSignal 对象（传给需要支持取消的操作）
    │                  │
    │                  ├── .aborted    ← 是否已经中止（布尔值）
    │                  ├── .reason    ← 中止原因
    │                  └── addEventListener('abort', handler)  ← 监听中止事件
    │
    └── .abort(reason)  ← 调用这个来触发中止
```

**核心思路**：`controller.abort()` 发出"取消信号"，所有持有 `signal` 的操作检测到信号后自行停止。

---

## 基本用法

```typescript
// 创建一个控制器
const controller = new AbortController()
const signal = controller.signal

// 把 signal 传给支持取消的 API（如 fetch）
const fetchPromise = fetch('/api/data', { signal })

// 5秒后取消
setTimeout(() => {
  controller.abort('用户超时')
}, 5000)

try {
  const response = await fetchPromise
  // 如果在5秒内完成，正常处理
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('请求被取消了，原因：', controller.signal.reason)
  } else {
    throw error  // 其他错误正常处理
  }
}
```

当 `controller.abort()` 被调用时：
- `signal.aborted` 变为 `true`
- `signal.reason` 记录原因
- `fetch` 感知到 signal 中止，立即拒绝 Promise（抛出 `AbortError`）

---

## 自定义函数如何支持取消？

`fetch` 内置了对 `signal` 的支持，但你自己写的函数怎么办？

**方式一：定期检查 `signal.aborted`**

```typescript
async function processLargeData(data: string[], signal: AbortSignal) {
  const results = []
  
  for (const item of data) {
    // 每次迭代前检查是否已中止
    if (signal.aborted) {
      throw new Error(`操作被取消：${signal.reason}`)
    }
    
    const result = await processItem(item)
    results.push(result)
  }
  
  return results
}
```

**方式二：监听 `abort` 事件（适合长时间等待）**

```typescript
async function waitForEvent(signal: AbortSignal): Promise<Event> {
  return new Promise((resolve, reject) => {
    const handler = (event: Event) => resolve(event)
    
    // 如果取消，立即 reject
    signal.addEventListener('abort', () => {
      reject(new Error(`等待被取消：${signal.reason}`))
    }, { once: true })
    
    // 正常情况下监听事件
    eventSource.addEventListener('message', handler, { once: true })
  })
}
```

**方式三：传递给子操作**

```typescript
async function complexTask(signal: AbortSignal) {
  // 把 signal 传递给所有子操作，它们也能被取消
  const data = await fetchData({ signal })
  const processed = await processData(data, signal)
  return await saveResult(processed, signal)
}
```

---

## Claude Code 中的实际用法

### QueryEngine 中的中断控制

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L187-L203)**

```typescript
export class QueryEngine {
  private abortController: AbortController
  
  constructor(config: QueryEngineConfig) {
    // 每个会话有一个 AbortController
    this.abortController = config.abortController ?? createAbortController()
  }
  
  // 用户中断时调用
  interrupt(): void {
    this.abortController.abort()   // 发出中止信号
  }
}
```

**文件：[src/QueryEngine.ts](../src/QueryEngine.ts#L1158-L1160)**

当用户按下 Ctrl+C 或发送新消息时，调用 `interrupt()`，这会向正在执行的 `queryLoop` 发出中止信号。

### queryLoop 检查中止信号

**文件：[src/query.ts](../src/query.ts#L1015)**

```typescript
// 在工具执行前检查
if (toolUseContext.abortController.signal.aborted) {
  // 中止了，不执行工具，终止循环
  return { type: 'interrupt', reason: 'user_interrupt' }
}
```

**文件：[src/query.ts](../src/query.ts#L664)**

```typescript
// 调用 API 时传入 signal
const response = await callAPI({
  messages,
  signal: toolUseContext.abortController.signal,  // 如果中止，fetch 会立即停止
})
```

这样，无论 `queryLoop` 在哪个阶段（等待 API、执行工具、处理响应），中止信号都能让它尽快停止。

---

## 取消 vs 完成的状态区分

Claude Code 里用 `signal.reason` 区分不同的中止原因：

**文件：[src/query.ts](../src/query.ts#L1046)**

```typescript
// 区分"用户中断"和"其他原因中止"
if (toolUseContext.abortController.signal.reason !== 'interrupt') {
  // 不是用户主动中断，可能是超时或错误，需要特殊处理
}
```

取消信号有多种来源：
- 用户按 Ctrl+C（原因：`'interrupt'`）
- 用户发送新消息，中断当前轮次
- 会话超时
- 外部调用 `QueryEngine.interrupt()`

---

## 并发控制：`p-map` 限制并发数

Claude Code 里不只是取消，还有**并发数量控制**。

**文件：[package.json](../package.json#L57)**

```json
"p-map": "^7.0.4",
```

`p-map` 是一个可以限制并发数的 `Promise.all` 替代品：

```typescript
import pMap from 'p-map'

// 同时执行最多 3 个工具，不是全部并行
const results = await pMap(
  toolCalls,
  async (toolCall) => executeTool(toolCall),
  { concurrency: 3 }  // 最大并发数
)
```

**为什么需要限制并发？**

假设 Claude 同时发出 20 个工具调用：
- 如果全部并行：同时打开 20 个文件、20 个网络请求，可能超出系统限制
- 如果限制为 10：最多 10 个同时跑，既快又不崩

在 [src/services/tools/toolOrchestration.ts](../src/services/tools/toolOrchestration.ts) 里，工具执行的默认并发数是 10。

---

## 竞争条件：多个异步操作的顺序问题

理解了并发，还要理解**竞争条件（Race Condition）**：

```typescript
// ❌ 竞争条件：两个操作都在修改同一个变量
let messages = []

async function addMessage() {
  const msg = await fetchMessage()
  messages.push(msg)   // 如果多个 addMessage 同时在跑，push 的顺序不确定
}

// ✅ 避免竞争：用不可变更新
async function addMessage() {
  const msg = await fetchMessage()
  messages = [...messages, msg]   // 创建新数组（仍有竞争风险）
}

// ✅ 真正安全：串行化（一次只允许一个）
const queue = []
let processing = false

async function addMessageSafe() {
  const msg = await fetchMessage()
  queue.push(msg)
  if (!processing) processQueue()
}
```

Claude Code 通过设计规避了大多数竞争条件：
- `mutableMessages` 数组在 `queryLoop` 的单一路径里更新，不并发修改
- React 状态更新通过 `setAppState` 串行化
- 工具执行时区分"并发安全"（只读操作）和"非并发安全"（写操作），分批执行

---

## 本节小结

- `AbortController` 是取消异步操作的标准方案，一个控制器对应一个 `signal`
- 调用 `controller.abort(reason)` 发出取消信号，持有 `signal` 的操作自行停止
- 自定义函数通过检查 `signal.aborted` 或监听 `abort` 事件来支持取消
- Claude Code 里，`QueryEngine.interrupt()` → `abortController.abort()` → `queryLoop` 检测并停止
- `p-map` 限制并发数，防止资源耗尽
- 竞争条件是并发编程的主要风险，Claude Code 通过架构设计避免了大多数竞争

## 前后呼应

- 本节的 `AbortController`，在 **[9-6 节](./9-6-runTools工具执行编排.md)** 的工具执行里会看到它如何被传递给每个工具
- 本节的并发控制，在 **[9-6 节](./9-6-runTools工具执行编排.md)** 的 `runTools()` 里会看到完整实现

## 下一节预告

第 3 章到此结束。接下来进入第 4 章：**React 与 Ink TUI**——终端界面是怎么用 React 渲染出来的？

➡️ [下一节：4-1 什么是 TUI，和 Web 界面有什么不同](./4-1-什么是TUI和Web界面有什么不同.md)
