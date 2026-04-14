# 3-3 async/await：让异步代码看起来同步

> **本节目标**：彻底理解 async/await 的语法、背后的 Promise 本质、错误处理、以及几个关键的"陷阱"。async/await 是 Claude Code 整个代码库最基础的异步语法，理解它是读懂 queryLoop 的前提。

---

## async/await 是什么：Promise 的语法糖

先说结论：**async/await 不是新的异步机制，它是 Promise 的语法糖**。

所谓"语法糖"，就是让代码写起来更甜（更简洁、更易读），但底层做的事情完全一样。

看这个对比：

```typescript
// Promise 链式写法
function fetchUser(id: string): Promise<User> {
  return fetch(`/api/users/${id}`)
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    })
    .then(data => data.user)
    .catch(error => {
      console.error("获取用户失败：", error)
      throw error  // 重新抛出
    })
}

// async/await 写法（等价！）
async function fetchUser(id: string): Promise<User> {
  try {
    const response = await fetch(`/api/users/${id}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    return data.user
  } catch (error) {
    console.error("获取用户失败：", error)
    throw error
  }
}
```

第二种写法看起来像同步代码，但它们做的事情**完全相同**。

---

## `async` 关键字：让函数返回 Promise

在函数声明前加 `async`，这个函数就变成了**异步函数**：

```typescript
// 普通函数
function add(a: number, b: number): number {
  return a + b
}

// 异步函数
async function addAsync(a: number, b: number): Promise<number> {
  return a + b
}
```

**异步函数的特性**：
1. 总是返回 `Promise`，即使你 `return` 一个普通值
2. 可以在函数内部使用 `await`
3. 如果函数内部抛出异常，返回的 Promise 会 rejected

```typescript
async function example() {
  return 42        // 等价于 return Promise.resolve(42)
}

async function failing() {
  throw new Error("出错了")  // 等价于 return Promise.reject(new Error(...))
}

example().then(v => console.log(v))   // 42
failing().catch(e => console.error(e.message))  // 出错了
```

---

## `await` 关键字：暂停执行，等待 Promise

`await` 只能在 `async` 函数内部使用。它的作用是：

1. **暂停当前函数的执行**，等待 Promise 完成
2. **不阻塞事件循环**——暂停的是这个函数，其他任务可以继续执行
3. 当 Promise 完成后，**从暂停的地方继续执行**，并且把 Promise 的值作为 `await` 表达式的结果

```typescript
async function queryAPI() {
  console.log("1. 开始请求")
  
  const response = await fetch('/api/data')
  // ↑ 这里暂停了，等待 fetch 完成
  // 等待期间，事件循环可以处理其他任务
  // fetch 完成后，从这里继续
  
  console.log("2. 请求完成")
  
  const data = await response.json()
  // ↑ 再次暂停，等待 JSON 解析完成
  
  console.log("3. 解析完成")
  return data
}
```

### 关键：await 不阻塞线程

这是最重要的理解点。`await` 暂停的只是**这个函数**，不是整个 JavaScript 线程。

```typescript
async function slow() {
  console.log("slow 开始")
  await new Promise(resolve => setTimeout(resolve, 1000))  // 等1秒
  console.log("slow 结束")
}

async function fast() {
  console.log("fast 开始")
  await Promise.resolve()  // 微任务，几乎立即
  console.log("fast 结束")
}

slow()   // 启动，但不等它
fast()   // 立即启动

// 输出：
// slow 开始
// fast 开始
// fast 结束
// （1秒后）
// slow 结束
```

`slow()` 在等待的 1 秒里，`fast()` 已经完整跑完了。这就是"不阻塞事件循环"的含义。

---

## 错误处理：用 try/catch 捕获 await 的错误

当 `await` 的 Promise rejected 时，会抛出异常，可以用 `try/catch` 捕获：

```typescript
async function fetchData() {
  try {
    const response = await fetch('/api/data')
    
    if (!response.ok) {
      throw new Error(`请求失败：${response.status}`)
    }
    
    const data = await response.json()
    return data
    
  } catch (error) {
    // 捕获两种错误：
    // 1. fetch 失败（网络错误）→ await 抛出
    // 2. 手动 throw 的错误
    console.error("出错了：", error)
    throw error  // 可以选择重新抛出，让调用者知道
  }
}
```

这比 Promise 的 `.catch()` 直观得多，因为和同步代码的错误处理方式完全一样。

### 多个 await 的错误处理

```typescript
async function processFile(path: string) {
  try {
    const content = await readFile(path)      // 可能抛出
    const parsed = await parseContent(content) // 可能抛出
    const result = await saveResult(parsed)    // 可能抛出
    return result
  } catch (error) {
    // 任何一步的错误都在这里处理
    // 如何知道是哪一步失败了？检查 error 类型或 message
    if (error instanceof FileNotFoundError) {
      console.error("文件不存在")
    } else {
      throw error
    }
  }
}
```

---

## await 的底层：编译后是什么？

理解 async/await 的本质，看看 TypeScript 编译后的代码（简化版）：

```typescript
// 你写的
async function fetchUser(id: string) {
  const response = await fetch(`/api/${id}`)
  return await response.json()
}
```

编译后大致等价于：

```javascript
// 编译后（简化示意）
function fetchUser(id) {
  return fetch(`/api/${id}`)
    .then(response => response.json())
}
```

更复杂的情况，编译器会生成一个**状态机**，记住每个 `await` 的位置，在 Promise 完成后从正确的位置恢复执行。

---

## 常见陷阱一：在循环里用 await

这是新手最常犯的错误：

```typescript
// ❌ 错误：串行执行，总时间 = 所有请求时间之和
async function fetchAllUsers(ids: string[]) {
  const users = []
  for (const id of ids) {
    const user = await fetchUser(id)  // 每次都等上一个完成才开始下一个
    users.push(user)
  }
  return users
}

// ✅ 正确：并行执行，总时间 = 最慢那个请求的时间
async function fetchAllUsers(ids: string[]) {
  return Promise.all(ids.map(id => fetchUser(id)))
}
```

**什么时候必须串行？** 当第二个请求依赖第一个请求的结果时：

```typescript
// 这里必须串行——用户 ID 来自第一个请求
const user = await fetchCurrentUser()
const posts = await fetchUserPosts(user.id)  // 依赖 user.id
```

**判断准则**：互不依赖的异步操作用 `Promise.all` 并行；有依赖关系的用串行 `await`。

---

## 常见陷阱二：忘记 await

```typescript
async function saveUser(user: User) {
  // ❌ 忘记了 await：立即返回，不等保存完成
  database.save(user)
  
  // 这里代码继续执行，但 save 可能还没完成！
  console.log("保存完成")  // 这是谎言
}

async function saveUser(user: User) {
  // ✅ 等待保存完成
  await database.save(user)
  console.log("保存完成")  // 这才是真的完成了
}
```

忘记 `await` 不会报错，代码会继续执行，但可能出现**竞争条件**（race condition）——操作还没完成就访问了结果。

---

## 常见陷阱三：并发 await 的写法

```typescript
// ❌ 这看起来是并行，实际是串行！
async function wrong() {
  const a = await fetchA()   // 等 A 完成
  const b = await fetchB()   // 然后才等 B
  // 总时间：timeA + timeB
}

// ✅ 真正的并行
async function correct() {
  const [a, b] = await Promise.all([fetchA(), fetchB()])
  // 总时间：max(timeA, timeB)
}

// ✅ 另一种并行写法：先启动，后等待
async function alsoCorrect() {
  const promiseA = fetchA()   // 立即启动，不等待
  const promiseB = fetchB()   // 立即启动，不等待
  
  const a = await promiseA   // 等待 A 结果
  const b = await promiseB   // 等待 B 结果（B 可能已经完成了）
}
```

---

## 在 Claude Code 里的实际应用

`queryLoop` 里每一步都是异步的，看一个简化版：

**文件：[src/query.ts](../src/query.ts#L307-L337)**

```typescript
async function* queryLoop(params: QueryParams) {
  while (true) {
    // await 等待 API 调用完成，但不阻塞事件循环
    // 等待期间，Ink TUI 还在刷新，用户输入还能处理
    const response = await callAnthropicAPI(messages)
    
    // for await 处理流式响应（3-5节会详细讲）
    for await (const event of response) {
      yield event
    }
    
    // await 等待所有工具执行完成
    const toolResults = await runTools(toolUseBlocks, context)
    
    // 如果没有更多工具调用，退出循环
    if (toolResults.length === 0) break
    
    // 把工具结果加入消息，准备下一轮
    messages = [...messages, ...toolResults]
  }
}
```

每个 `await` 都精确地在"我需要结果才能继续"的地方等待，其他时间让出控制权，让 TUI 更新、让用户交互得以处理。

---

## 本节小结

- `async` 函数总是返回 Promise，可以在内部使用 `await`
- `await` 暂停当前函数等待 Promise，但不阻塞事件循环
- 用 `try/catch` 处理 `await` 的错误，等价于 Promise 的 `.catch()`
- 循环里用 `await` 会导致串行执行——互不依赖的操作用 `Promise.all` 并行
- "先启动后等待"模式：`const p = fetch(...)` 然后 `await p`
- 忘记 `await` 是常见 bug，代码不报错但行为错误

## 前后呼应

- 本节的 `async function*` 语法引入了 Generator 的概念，**[3-4 节](./3-4-Generator函数可暂停的函数.md)** 会正式讲 Generator
- 本节说的"`await` 让出控制权"，在 **[12-4 节](./12-4-实时更新流式token如何驱动TUI刷新.md)** 会看到这如何让 TUI 能实时刷新

## 下一节预告

下一节讲 **Generator 函数**——一种可以"暂停"和"恢复"的函数。这是理解 `async function*`（AsyncGenerator，Claude Code 核心）的必经之路。

➡️ [下一节：3-4 Generator 函数：可暂停的函数](./3-4-Generator函数可暂停的函数.md)
