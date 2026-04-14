# 3-5 AsyncGenerator：流式数据的关键

> **本节目标**：彻底理解 AsyncGenerator——它结合了 Generator 的"可暂停"和 async/await 的"异步等待"，是 Claude Code 整个 queryLoop 的实现基础。这是本章最重要的一节，请一字不漏地读完。

---

## 回顾两个概念，引出第三个

我们已经学了：
- **Generator**（`function*`）：可以暂停的函数，`yield` 产出值，按需消费
- **async/await**：等待异步操作，让代码看起来同步

现在把这两个组合起来：**一个可以暂停的函数，每次产出的值都可能需要等待异步操作**。

这就是 **AsyncGenerator**（`async function*`）。

---

## AsyncGenerator 的语法

```typescript
// async function* = 异步 Generator
async function* tokenStream() {
  // 可以 await 异步操作
  const connection = await openConnection()
  
  while (connection.hasMore()) {
    const token = await connection.readNextToken()  // 等待下一个 token
    yield token                                     // 产出给消费者
  }
}
```

消费 AsyncGenerator：用 `for await...of`（注意有 `await`）：

```typescript
// 消费者
for await (const token of tokenStream()) {
  console.log(token)  // 每来一个 token，立即处理
}
```

`for await...of` 做了什么：
1. 调用 `.next()` 启动 AsyncGenerator
2. 等待返回的 Promise 完成（AsyncGenerator 的 `.next()` 返回 `Promise<{value, done}>`）
3. 拿到值，执行循环体
4. 再调用 `.next()`，等待...
5. 直到 `done: true` 结束

---

## Generator vs AsyncGenerator 对比

| 特性 | Generator (`function*`) | AsyncGenerator (`async function*`) |
|------|------------------------|-------------------------------------|
| 内部可用 | `yield` | `yield` + `await` |
| `.next()` 返回 | `{value, done}` | `Promise<{value, done}>` |
| 消费方式 | `for...of` | `for await...of` |
| 使用场景 | 同步序列、懒求值 | 流式数据、事件流、API 流 |
| 典型用途 | 生成器、迭代器 | **Claude Code 的 queryLoop** |

---

## 为什么 queryLoop 是 AsyncGenerator？

来看 `queryLoop` 需要做的事情：

```
1. 调用 Anthropic API（等待，异步）
2. 收到流式响应（一个 token 一个 token 来，异步）
3. 每个 token 都要立即传给 TUI 显示（产出，yield）
4. 收到工具调用请求时，执行工具（等待，异步）
5. 把工具结果发回 API（等待，异步）
6. 继续收流式响应（循环）
```

用伪代码表达：

```
需要 await（异步）→ 调用 API
需要 yield（流式传出）→ 产出 token 给 TUI
需要 await（异步）→ 执行工具
需要 yield（流式传出）→ 产出工具结果给 TUI
需要 await（异步）→ 再次调用 API
...
```

**同时需要 `await` 和 `yield`，这只有 AsyncGenerator 能做到。**

---

## 一个完整的模拟示例

让我们写一个简化版的"流式 API 调用"，感受 AsyncGenerator 的工作方式：

```typescript
// 模拟 Anthropic API 的流式响应
async function* simulateStreamingAPI(prompt: string) {
  const words = `Claude 正在回答：${prompt}`.split(' ')
  
  for (const word of words) {
    // 模拟网络延迟：每个 token 之间有 100ms 间隔
    await new Promise(resolve => setTimeout(resolve, 100))
    yield { type: 'text_delta', text: word + ' ' }
  }
  
  // 模拟工具调用
  yield { type: 'tool_use', name: 'ReadFile', input: { path: 'README.md' } }
  
  // 模拟工具结果发回后继续回答
  await new Promise(resolve => setTimeout(resolve, 200))
  yield { type: 'text_delta', text: '（读取完毕）' }
}

// 简化版 queryLoop
async function* queryLoop(prompt: string) {
  const stream = simulateStreamingAPI(prompt)
  
  for await (const event of stream) {
    if (event.type === 'text_delta') {
      yield event  // 直接传递给上层（TUI）
      
    } else if (event.type === 'tool_use') {
      // 执行工具（异步操作）
      console.log(`执行工具：${event.name}`)
      await new Promise(resolve => setTimeout(resolve, 300))  // 模拟工具执行
      
      yield { type: 'tool_result', tool: event.name, result: '文件内容...' }
    }
  }
}

// 消费（模拟 TUI）
async function main() {
  for await (const event of queryLoop("你好")) {
    if (event.type === 'text_delta') {
      process.stdout.write(event.text)  // 实时显示文字
    } else if (event.type === 'tool_result') {
      console.log('\n工具完成：', event.result)
    }
  }
}
```

运行后，你会看到文字一个词一个词地出现，然后工具执行，然后继续——**这就是 Claude Code 的实际行为**。

---

## 真实的 queryLoop 签名

**文件：[src/query.ts](../src/query.ts#L241-L251)**

```typescript
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<
  | StreamEvent           // 流式响应事件（text_delta、tool_use 等）
  | RequestStartEvent     // 请求开始事件
  | Message               // 完整消息
  | TombstoneMessage      // 消息墓碑（用于删除消息）
  | ToolUseSummaryMessage,// 工具使用摘要
  Terminal                // 返回值类型（AsyncGenerator 的第二个泛型参数）
> {
  // ...
}
```

返回类型 `AsyncGenerator<YieldType, ReturnType>` 有两个泛型参数：
- 第一个：`yield` 产出的类型（联合类型，有多种事件）
- 第二个：`return` 返回的类型（`Terminal`，表示终止原因）

---

## `for await...of` 的执行时序

让我们追踪一次完整的流式交互：

```
TUI（消费者）                          queryLoop（AsyncGenerator）
     │                                        │
     │  for await (const event of query()) {  │
     │──────────────────────────────────────→ │  开始执行
     │                                        │
     │                                        │  await callAPI(...)
     │                                        │  （等待 API，让出控制权）
     │                                        │
     │ （TUI 继续刷新，处理用户输入）            │  （等待中...）
     │                                        │
     │                                        │  API 开始返回第一个 token
     │                                        │  yield { type: 'text_delta', text: 'Hello' }
     │ ← event = { type: 'text_delta', ... }  │  暂停
     │                                        │
     │  显示 'Hello'                           │
     │                                        │
     │  请求下一个                             │
     │──────────────────────────────────────→ │  恢复
     │                                        │  yield { type: 'text_delta', text: ' World' }
     │ ← event = { type: 'text_delta', ... }  │  暂停
     │                                        │
     │  显示 ' World'                          │
     │                                        │
     │  请求下一个                             │
     │──────────────────────────────────────→ │  恢复
     │                                        │  yield { type: 'tool_use', name: 'Bash' }
     │ ← event = { type: 'tool_use', ... }    │  暂停
     │                                        │
     │  显示工具调用UI                         │
     │  请求下一个                             │
     │──────────────────────────────────────→ │  恢复
     │                                        │  await runTools(...)
     │                                        │  （工具执行中，让出控制权）
     │                                        │
     │ （TUI 显示"工具执行中..."）              │  （等待中...）
     │                                        │
     │                                        │  工具完成
     │                                        │  yield { type: 'tool_result', ... }
```

**关键观察**：TUI 和 queryLoop 是协作关系——TUI 消费一个事件，queryLoop 产出一个事件，交替进行。TUI 永远不会"卡死"等待，因为 queryLoop 每产出一个事件就暂停了，控制权回到 TUI。

---

## AsyncGenerator 的错误处理

```typescript
async function* riskyStream() {
  yield 1
  throw new Error("流式数据中断了！")
  yield 2  // 不会执行到这里
}

// 方式一：try/catch 在消费处
try {
  for await (const val of riskyStream()) {
    console.log(val)
  }
} catch (error) {
  console.error("捕获错误：", error.message)
}

// 方式二：在 AsyncGenerator 内部处理
async function* safeStream() {
  try {
    yield* riskyStream()
  } catch (error) {
    yield { type: 'error', message: error.message }  // 把错误转成事件产出
  }
}
```

在 Claude Code 里，`queryLoop` 内部对各种错误有细致的处理——有些错误会触发重试，有些会终止循环，有些会转换成用户可见的错误消息。

---

## AsyncGenerator 的 `return` 值

注意 AsyncGenerator 可以有 `return` 值，这和普通 Generator 一样：

```typescript
async function* gen(): AsyncGenerator<string, number> {
  yield "hello"
  yield "world"
  return 42   // 返回值
}

const g = gen()
await g.next()   // { value: "hello", done: false }
await g.next()   // { value: "world", done: false }
await g.next()   // { value: 42, done: true }
```

但 `for await...of` **不会接收返回值**——它在 `done: true` 时直接停止，不看 `value`。

想拿到返回值，需要手动调用 `.next()`：

```typescript
// 或者用 yield*（它会接收返回值）
async function* wrapper() {
  const returnValue = yield* gen()   // returnValue = 42
  console.log("gen 的返回值：", returnValue)
}
```

这就是为什么 `query` 函数用 `yield*` 调用 `queryLoop`——它需要接收 `queryLoop` 的返回值（`Terminal` 类型，表示循环为何终止）。

---

## 手动驱动 AsyncGenerator

有时不用 `for await...of`，而是手动调用 `.next()`，可以有更精确的控制：

```typescript
const gen = queryLoop(params)

// 手动消费
let result = await gen.next()
while (!result.done) {
  processEvent(result.value)
  result = await gen.next()
}

const terminal = result.value  // done: true 时的 return 值
```

Claude Code 的 `QueryEngine` 层就是这样消费 `query()` 的——它需要对每个事件做额外处理（更新 React 状态、记录消息历史），所以用手动方式而不是 `for await`。

---

## 总结：AsyncGenerator 的全貌

```
async function* queryLoop() {
    │
    │ yield event1        ← 同步地产出事件（立即给调用者）
    │
    │ await promise1      ← 异步等待（不阻塞线程，让出控制权）
    │
    │ yield event2        ← 再次产出
    │
    │ for await (x of stream) {
    │   yield x           ← 内部 for await 和 yield 结合
    │ }
    │
    │ return terminal     ← 最终返回值（done: true 时携带）
}

调用者用 for await...of 消费，或手动 .next()
每次 .next() 返回 Promise<{value, done}>
```

---

## 本节小结

- AsyncGenerator（`async function*`）结合了 Generator 的"可暂停"和 async/await 的"异步等待"
- 每次 `yield` 产出一个值，调用者用 `for await...of` 消费
- `for await...of` 自动处理 `.next()` 返回的 Promise，等待异步完成
- 可以同时 `yield`（产出）和 `await`（等待），这是 `queryLoop` 实现的关键
- `yield*` 把另一个 AsyncGenerator 的所有产出透明传递，并接收其返回值
- 错误可以在消费处用 `try/catch` 捕获，也可以在 Generator 内部处理

## 前后呼应

- 本节讲的一切，在 **[9-1 节](./9-1-queryLoop的全局结构.md)** 开始拆解真实的 `queryLoop` 时会全部用上
- 本节的 `for await...of` 消费模式，在 **[10-1 节](./10-1-QueryEngine-vs-query两层架构.md)** 会看到 `QueryEngine` 如何消费 `query()` 的输出

## 下一节预告

下一节讲**并发控制与 AbortController**——当多个异步操作并行时，如何取消其中一个？Claude Code 如何在用户发新消息时中止正在进行的 API 调用？

➡️ [下一节：3-6 并发控制与 AbortController](./3-6-并发控制与AbortController.md)
