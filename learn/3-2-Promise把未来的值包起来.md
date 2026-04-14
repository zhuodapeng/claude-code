# 3-2 Promise：把"未来的值"包起来

> **本节目标**：深入理解 Promise 是什么、为什么需要它、它的三种状态、链式调用的原理、错误处理机制，以及 `Promise.all` / `Promise.race` 等并发工具。这些是 async/await 的底层，也是 Claude Code 并发工具执行的基础。

---

## 先讲"回调地狱"：Promise 要解决的问题

在 Promise 出现之前（2015年前），异步操作用**回调函数（Callback）**处理：

```javascript
// 读文件，然后解析，然后保存结果
fs.readFile('config.json', (err, data) => {
  if (err) {
    console.error('读文件失败', err)
    return
  }
  
  parseJSON(data, (err, config) => {
    if (err) {
      console.error('解析失败', err)
      return
    }
    
    saveConfig(config, (err, result) => {
      if (err) {
        console.error('保存失败', err)
        return
      }
      
      logResult(result, (err) => {
        if (err) {
          console.error('记录失败', err)
          return
        }
        
        console.log('全部完成！')
        // 这里已经缩进了5层...
      })
    })
  })
})
```

这就是著名的**"回调地狱"（Callback Hell）**，也叫"厄运金字塔（Pyramid of Doom）"：
1. 代码向右缩进，越来越深
2. 错误处理分散在每一层，容易遗漏
3. 无法用 `try/catch` 统一处理异步错误
4. 很难理解代码的执行顺序

**Promise 的出现，就是要解决这个问题。**

---

## Promise 是什么：一个"承诺"对象

Promise 是一个**代表异步操作最终结果的对象**。你拿到 Promise 的时候，操作可能还没完成，但你已经有了一个"承诺"——它最终会告诉你结果（成功或失败）。

用生活类比：

> 你去餐厅点了一份牛排，服务员给你一个**号码牌**。这个号码牌就是 Promise：
> - 牛排还没好（Pending 状态）
> - 你可以先去找座位，不用站在厨房门口等
> - 牛排好了服务员会叫你（Fulfilled 状态）
> - 如果厨房没原料，服务员来告诉你没有（Rejected 状态）

---

## Promise 的三种状态

```
┌─────────────────────────────────────────────────────────┐
│                    Promise 状态机                        │
│                                                         │
│                   ┌──────────┐                          │
│                   │ Pending  │  ← 初始状态，操作进行中    │
│                   │（等待中） │                          │
│                   └────┬─────┘                          │
│                        │                                │
│             ┌──────────┴──────────┐                     │
│             ▼                     ▼                     │
│      ┌────────────┐        ┌────────────┐               │
│      │ Fulfilled  │        │  Rejected  │               │
│      │  （已完成） │        │  （已拒绝） │               │
│      └────────────┘        └────────────┘               │
│                                                         │
│      状态一旦确定，永远不会改变！                          │
└─────────────────────────────────────────────────────────┘
```

关键特性：**状态只能从 Pending 变到 Fulfilled 或 Rejected，且只能变一次，之后永远不变。**

---

## 创建 Promise

```javascript
const promise = new Promise((resolve, reject) => {
  // 这个函数叫做 executor，会立即执行
  
  // 模拟异步操作（比如网络请求）
  setTimeout(() => {
    const success = Math.random() > 0.5
    
    if (success) {
      resolve("操作成功！")   // 将 Promise 变为 Fulfilled，传入成功值
    } else {
      reject(new Error("操作失败！"))   // 将 Promise 变为 Rejected，传入错误
    }
  }, 1000)
})
```

`executor` 函数接收两个参数：
- `resolve(value)`：调用它，Promise 进入 Fulfilled 状态，`value` 是成功值
- `reject(error)`：调用它，Promise 进入 Rejected 状态，`error` 是失败原因

---

## 消费 Promise：`.then()` 和 `.catch()`

```javascript
promise
  .then(value => {
    // Promise fulfilled 时执行
    console.log("成功：", value)
  })
  .catch(error => {
    // Promise rejected 时执行
    console.error("失败：", error.message)
  })
  .finally(() => {
    // 无论成功失败都执行（清理资源用）
    console.log("操作结束")
  })
```

### `.then()` 的链式调用原理

这是 Promise 最重要的设计：**`.then()` 总是返回一个新的 Promise**。

```javascript
fetch('/api/user')
  .then(response => response.json())   // 返回一个新 Promise
  .then(user => {
    console.log(user.name)
    return fetch(`/api/posts?userId=${user.id}`)  // 返回另一个 Promise
  })
  .then(response => response.json())
  .then(posts => {
    console.log(posts)
  })
  .catch(error => {
    // 链上任何地方的错误都会被这里捕获！
    console.error(error)
  })
```

和回调地狱对比：
- 代码是**扁平**的，不是嵌套的
- 错误处理**集中**在一个 `.catch()` 里
- 逻辑流程一目了然

### `.then()` 的返回值规则

`.then(callback)` 里 `callback` 的返回值决定了链上下一个 Promise 的状态：

```javascript
Promise.resolve(1)
  .then(val => val + 1)          // 返回普通值 2 → 下一个收到 2
  .then(val => val * 3)          // 返回普通值 6 → 下一个收到 6
  .then(val => {
    return new Promise(resolve => {
      setTimeout(() => resolve(val + 10), 1000)
    })
  })                             // 返回 Promise → 等这个 Promise 完成
  .then(val => console.log(val)) // 1秒后输出 16
```

---

## 错误传播机制

这是 Promise 相对回调的核心优势：

```javascript
fetch('/api/data')
  .then(response => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)   // 抛出错误
    }
    return response.json()
  })
  .then(data => {
    // 如果上面抛了错，这里会被跳过
    return processData(data)
  })
  .then(result => {
    // 如果上面任何一步失败，这里也被跳过
    console.log(result)
  })
  .catch(error => {
    // 链上任何一步的错误，最终都在这里被捕获
    console.error("整个流程失败了：", error.message)
  })
```

错误会**沿着链传播**，直到遇到 `.catch()`。不需要在每一步都检查错误。

---

## 快速创建 Promise 的工具方法

```javascript
// 直接创建一个已完成的 Promise
Promise.resolve(42)
  .then(val => console.log(val))  // 42

// 直接创建一个已失败的 Promise
Promise.reject(new Error("直接失败"))
  .catch(err => console.error(err))
```

---

## 并发控制：`Promise.all` 和 `Promise.race`

这两个工具在 Claude Code 里非常重要。

### `Promise.all`：等所有 Promise 都完成

```javascript
// 同时发起三个请求，等全部完成
const [user, posts, comments] = await Promise.all([
  fetch('/api/user').then(r => r.json()),
  fetch('/api/posts').then(r => r.json()),
  fetch('/api/comments').then(r => r.json()),
])
```

关键：**三个请求是并行的，总等待时间 = 最慢那个请求的时间**，而不是三个时间相加。

```
没有 Promise.all（串行）：
  请求1（200ms）────→ 请求2（300ms）────→ 请求3（100ms）
  总时间：600ms

使用 Promise.all（并行）：
  请求1（200ms）────→
  请求2（300ms）──────────→
  请求3（100ms）──→
  总时间：300ms（只等最慢的）
```

**如果其中一个 rejected，`Promise.all` 立即 rejected（其他请求结果被丢弃）**。

### `Promise.allSettled`：等所有完成，不管成功失败

```javascript
const results = await Promise.allSettled([
  Promise.resolve(1),
  Promise.reject(new Error("失败了")),
  Promise.resolve(3),
])

results.forEach(result => {
  if (result.status === 'fulfilled') {
    console.log("成功：", result.value)
  } else {
    console.log("失败：", result.reason.message)
  }
})
// 成功：1
// 失败：失败了
// 成功：3
```

### `Promise.race`：谁先完成用谁

```javascript
// 加超时功能
const timeout = new Promise((_, reject) => 
  setTimeout(() => reject(new Error("超时")), 5000)
)

const result = await Promise.race([
  fetch('/api/data'),  // 正常请求
  timeout,             // 5秒后超时
])
// 如果请求在5秒内完成，result 是请求结果
// 如果超过5秒，抛出超时错误
```

---

## Claude Code 里的 Promise 使用

### 工具并行执行

在 [src/services/tools/toolOrchestration.ts](../src/services/tools/toolOrchestration.ts) 里，多个"并发安全"的工具是并行执行的：

```typescript
// 伪代码展示思路
const concurrentResults = await Promise.all(
  concurrentTools.map(tool => tool.call(args, context))
)
```

这让 Claude 的多个读操作（比如同时读多个文件）可以并行，而不是一个等一个。

### 超时控制

工具执行时需要超时保护：

```typescript
// 工具调用 + 超时控制
const result = await Promise.race([
  tool.call(args, context),
  new Promise((_, reject) => 
    setTimeout(() => reject(new Error("工具超时")), timeoutMs)
  )
])
```

---

## 一个容易犯的错误：忘记 await 或 return

```javascript
// ❌ 错误：没有 return，链中断了
promise
  .then(val => {
    doSomethingAsync(val)   // 这里应该 return，否则链不等这个 Promise
  })
  .then(val => {
    console.log(val)  // undefined！因为上一步没有 return
  })

// ✅ 正确：return 确保链正确传递
promise
  .then(val => {
    return doSomethingAsync(val)  // 返回 Promise，链会等它完成
  })
  .then(val => {
    console.log(val)  // 正确的值
  })
```

这个错误在使用 async/await 之后基本消失了，但理解它有助于你调试遗留代码。

---

## 本节小结

- Promise 是代表"未来值"的对象，有三个状态：Pending、Fulfilled、Rejected
- 状态一旦确定不可更改
- `.then()` 返回新 Promise，实现链式调用；错误沿链传播到 `.catch()`
- `Promise.all`：并行等待所有，有一个失败则整体失败
- `Promise.allSettled`：并行等待所有，逐一查看每个结果
- `Promise.race`：谁先完成用谁，常用于超时控制
- Claude Code 用 `Promise.all` 并行执行多个只读工具，提升性能

## 前后呼应

- 本节的 `Promise.all` 并行模式，在 **[9-6 节](./9-6-runTools工具执行编排.md)** 的 `runTools()` 会看到完整的工具并行执行实现
- 本节的错误传播机制，在 **[9-8 节](./9-8-循环的终止条件.md)** 讲循环终止条件时，错误如何在 AsyncGenerator 链路上传播有重要作用

## 下一节预告

下一节讲 **async/await**——它是 Promise 的语法糖，让异步代码看起来像同步代码。你将看到它如何让 `queryLoop` 的代码变得可读。

➡️ [下一节：3-3 async/await：让异步代码看起来同步](./3-3-async-await让异步看起来同步.md)
