# 3-4 Generator 函数：可暂停的函数

> **本节目标**：深入理解 Generator 是什么、`yield` 关键字的工作原理、调用者和 Generator 之间的"对话"机制、以及 `yield*` 委托。这节是理解 AsyncGenerator（Claude Code 的核心模式）最关键的铺垫。

---

## 一个普通函数的局限

在你到目前为止学过的所有编程语言里，函数都遵循同一个规则：

```
调用 → 执行 → 返回
```

**函数一旦开始执行，就会一直运行到 `return` 语句（或者函数结束）**，中途无法暂停、无法让调用者介入。

来看一个具体的问题：假设你需要生成一个无限的自然数序列，供外部代码按需取用：

```typescript
// ❌ 朴素方案：一次性生成所有——内存爆炸
function getAllNaturalNumbers(): number[] {
  const result = []
  for (let i = 0; ; i++) {
    result.push(i)  // 无限循环，内存耗尽
  }
  return result  // 永远不会执行到这里
}

// ❌ 另一个方案：回调——把控制权反转，代码逻辑分散
function generateNaturalNumbers(callback: (n: number) => boolean) {
  for (let i = 0; ; i++) {
    const shouldContinue = callback(i)  // 调用回调，由回调决定是否继续
    if (!shouldContinue) break
  }
}
generateNaturalNumbers(n => {
  console.log(n)
  return n < 5  // 取前6个
})
```

两种方案都不优雅。**我们想要的是：函数能产生一系列值，调用者按需取，函数等待直到调用者需要下一个值。**

这正是 Generator 要解决的问题。

---

## Generator 函数的语法

```typescript
// function 后面加 * 就是 Generator 函数
function* naturalNumbers() {
  let i = 0
  while (true) {
    yield i   // 暂停，把 i 交给调用者；等调用者需要下一个值时，从这里继续
    i++
  }
}
```

调用 Generator 函数，得到一个**迭代器（Iterator）**：

```typescript
const gen = naturalNumbers()   // 注意：这里不执行函数体！只是创建了迭代器

gen.next()  // { value: 0, done: false }  — 执行到第一个 yield，暂停
gen.next()  // { value: 1, done: false }  — 从暂停处继续，到下一个 yield
gen.next()  // { value: 2, done: false }  — 继续...
// 可以一直 .next() 下去，永不结束
```

---

## `yield` 的工作原理：暂停点

`yield` 是 Generator 里的核心关键字。每次执行到 `yield`：

1. 函数**暂停**
2. `yield` 后面的表达式作为 `.next()` 的返回值（放在 `{ value: ..., done: false }` 的 `value` 里）
3. 函数的整个执行状态（局部变量、循环计数等）被**保存**起来
4. 控制权交回给调用者

当调用者再次调用 `.next()` 时：
1. 从上次 `yield` 暂停的地方**恢复执行**
2. 之前保存的局部变量**完全恢复**，就好像从未暂停过

```typescript
function* steps() {
  console.log("步骤一开始")
  yield "第一步结果"              // 暂停点 1
  console.log("步骤二开始")
  yield "第二步结果"              // 暂停点 2
  console.log("全部完成")
  return "最终结果"               // done: true
}

const gen = steps()

console.log("=== 调用第一次 next ===")
const result1 = gen.next()
console.log(result1)

console.log("=== 调用第二次 next ===")
const result2 = gen.next()
console.log(result2)

console.log("=== 调用第三次 next ===")
const result3 = gen.next()
console.log(result3)
```

输出：
```
=== 调用第一次 next ===
步骤一开始
{ value: '第一步结果', done: false }
=== 调用第二次 next ===
步骤二开始
{ value: '第二步结果', done: false }
=== 调用第三次 next ===
全部完成
{ value: '最终结果', done: true }
```

这说明 Generator 函数的执行和调用者是**交替进行**的——函数产生一个值，调用者消费，然后函数继续，循环往复。

---

## Generator 的状态机本质

看清楚 Generator 的执行模型：

```
调用者                         Generator 函数
   │                                │
   │   gen = steps()                │
   │──────────────────────────────→ │  （创建迭代器，不执行函数体）
   │                                │
   │   gen.next()                   │
   │──────────────────────────────→ │  开始执行
   │                                │  console.log("步骤一开始")
   │                                │  执行到 yield "第一步结果"
   │ ← {value:'第一步结果',done:false} │  暂停，交还控制权
   │                                │
   │  （做一些事情...）               │  （冻结状态）
   │                                │
   │   gen.next()                   │
   │──────────────────────────────→ │  从暂停处恢复
   │                                │  console.log("步骤二开始")
   │                                │  执行到 yield "第二步结果"
   │ ← {value:'第二步结果',done:false} │  暂停
   │                                │
   │   gen.next()                   │
   │──────────────────────────────→ │  从暂停处恢复
   │                                │  console.log("全部完成")
   │                                │  执行到 return
   │ ← {value:'最终结果',done:true}   │  结束
```

**这就是"协程"（Coroutine）的概念**：两个执行单元协作运行，交替控制权。

---

## 用 `for...of` 消费 Generator

Generator 函数返回的迭代器实现了 `[Symbol.iterator]` 接口，可以直接用 `for...of` 遍历：

```typescript
function* range(start: number, end: number) {
  for (let i = start; i <= end; i++) {
    yield i
  }
}

for (const num of range(1, 5)) {
  console.log(num)
}
// 1, 2, 3, 4, 5
```

`for...of` 自动调用 `.next()`，当 `done: true` 时停止。

也可以用展开运算符：
```typescript
const nums = [...range(1, 5)]  // [1, 2, 3, 4, 5]
```

---

## 向 Generator 传值：`.next(value)` 的双向通信

这是一个更高级的特性：`.next()` 可以传入一个值，这个值会成为 `yield` 表达式的**返回值**。

是的，`yield` 既是产出值（输出），也能接收值（输入）：

```typescript
function* calculator() {
  let total = 0
  
  while (true) {
    const input = yield total   // yield total（输出当前值），接收输入赋给 input
    
    if (input === null) break   // 收到 null，结束
    
    total += input
  }
  
  return total  // 返回最终结果
}

const calc = calculator()

calc.next()         // 启动，{ value: 0, done: false }
calc.next(10)       // 传入 10，{ value: 10, done: false }
calc.next(20)       // 传入 20，{ value: 30, done: false }
calc.next(null)     // 结束，{ value: 30, done: true }
```

流程：
1. `calc.next()` — 启动，执行到 `yield total`（total=0），暂停，返回 0
2. `calc.next(10)` — `input` 收到 10，`total` 变为 10，执行到下一个 `yield total`，暂停，返回 10
3. `calc.next(20)` — `input` 收到 20，`total` 变为 30，执行到下一个 `yield total`，暂停，返回 30
4. `calc.next(null)` — `input` 收到 null，break，return 30，`done: true`

**注意第一次 `.next()` 传入的值会被忽略**，因为第一次执行时还没有在 `yield` 处暂停，没有地方接收值。

---

## `yield*`：委托给另一个 Generator

`yield*` 可以把控制权委托给另一个可迭代对象（包括 Generator）：

```typescript
function* inner() {
  yield 'a'
  yield 'b'
  yield 'c'
}

function* outer() {
  yield 1
  yield* inner()   // 委托给 inner，inner 的每个 yield 都会传递给外层调用者
  yield 2
}

console.log([...outer()])  // [1, 'a', 'b', 'c', 2]
```

`yield*` 就像是"把 inner 的所有产出，当作我自己的产出"。

**这在 Claude Code 里非常关键！** 在 [src/query.ts](../src/query.ts#L230) 里：

```typescript
export async function* query(params: QueryParams) {
  const consumedCommandUuids: string[] = []
  
  // yield* 把 queryLoop 产出的所有事件，当作 query 自己的产出
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  
  // queryLoop 完成后才执行这里
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

`query` 函数是对外暴露的接口，`queryLoop` 是内部实现。`yield*` 让两者之间的事件流无缝传递，同时在 `queryLoop` 完成后还能做清理工作。

---

## Generator 的提前终止：`.return()` 和 `.throw()`

### `.return(value)`：强制结束 Generator

```typescript
const gen = naturalNumbers()
gen.next()   // 0
gen.next()   // 1
gen.return("强制结束")   // { value: "强制结束", done: true }
gen.next()   // { value: undefined, done: true }  — 已经结束了
```

### `.throw(error)`：向 Generator 内部注入错误

```typescript
function* withErrorHandling() {
  try {
    yield 1
    yield 2
    yield 3
  } catch (e) {
    console.log("Generator 内部捕获了错误：", e.message)
    yield -1  // 捕获后还可以继续产出值
  }
}

const gen = withErrorHandling()
gen.next()           // { value: 1, done: false }
gen.throw(new Error("外部注入错误"))  
// 输出："Generator 内部捕获了错误：外部注入错误"
// 返回：{ value: -1, done: false }
```

---

## 为什么不直接返回数组？

你可能问：为什么不直接 `return [1, 2, 3, ...]`，而要用 Generator 这么复杂的东西？

**关键区别：惰性（Lazy）vs 即时（Eager）**

```typescript
// 即时求值：一次性计算所有值，全部放进内存
function getAllPrimes(limit: number): number[] {
  const primes = []
  for (let n = 2; n <= limit; n++) {
    if (isPrime(n)) primes.push(n)
  }
  return primes  // limit = 1亿时，内存爆炸
}

// 惰性求值：需要一个，计算一个
function* primes() {
  for (let n = 2; ; n++) {
    if (isPrime(n)) yield n  // 不需要存储，用完即释放
  }
}
```

**对于 Claude Code 的流式 API 响应，这个特性至关重要**：
- API 一次只返回一个 token
- 不知道总共有多少 token
- 不能等所有 token 收完再处理（用户要实时看到字）

Generator 完美匹配这个场景——每来一个 token，`yield` 给 TUI，TUI 立即显示，然后等待下一个 token。

---

## 本节小结

- Generator 函数（`function*`）可以在 `yield` 处暂停，保存完整状态，按需恢复
- `yield value` 产出一个值，`.next()` 消费它并获得下一个
- `.next(value)` 可以向 Generator 内部传递值，实现双向通信
- `yield*` 委托给另一个可迭代对象，透明地传递其所有产出
- Generator 是惰性的——不调用 `.next()` 就不计算，节省内存
- Generator 是 AsyncGenerator 的同步版本，下一节会加上异步能力

## 前后呼应

- 本节的 `yield*` 委托，直接出现在 **[src/query.ts](../src/query.ts#L230)** 的 `query` 函数里
- 本节的"Generator 是调用者和函数之间的协程"，在 **[9-9 节](./9-9-认知反转queryLoop是状态机.md)** 讲 queryLoop 是状态机时会深入理解

## 下一节预告

下一节讲 **AsyncGenerator**——把 Generator 的"可暂停"和 async/await 的"等待异步"结合起来。这就是 `queryLoop` 的实现基础，也是整个课程最核心的概念之一。

➡️ [下一节：3-5 AsyncGenerator：流式数据的关键](./3-5-AsyncGenerator流式数据的关键.md)
