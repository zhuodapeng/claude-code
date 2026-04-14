# 2-3 Zod：运行时类型校验

> **本节目标**：理解 Zod 的作用、用法，以及为什么 Claude Code 里每个工具都用它来定义输入参数。

---

## 一个 TypeScript 的根本局限

先说一个很多人没注意到的事实：

```typescript
function processUser(user: { name: string; age: number }) {
  console.log(user.name.toUpperCase())
}
```

TypeScript 的类型注解**只在编译时存在**。当代码编译成 JavaScript 运行时，类型信息全部消失了。

这意味着：

```javascript
// 运行时，TypeScript 类型消失了，没有任何保护
processUser({ name: null, age: "不是数字" })  // 运行时报错！
```

**TypeScript 类型是给你（开发者）看的，不是给程序（运行时）看的。**

对于 Claude Code，这个问题特别严重——LLM 生成的工具调用参数完全不可信。Claude 可能生成格式不对的 JSON，可能缺少必要字段，可能传错类型。

**这就是 Zod 要解决的问题：运行时校验。**

---

## Zod 是什么

Zod 是一个"schema 优先"的运行时类型校验库。你用 Zod 定义数据形状（schema），然后 Zod 在运行时验证数据是否符合这个形状。

更重要的是：**Zod schema 可以自动推断 TypeScript 类型**，让你只需定义一次，同时得到运行时校验和编译时类型。

---

## 基本用法

### 定义 schema

```typescript
import { z } from 'zod/v4'

// 基础类型
const nameSchema = z.string()
const ageSchema = z.number()
const flagSchema = z.boolean()

// 对象 schema
const userSchema = z.object({
  name: z.string(),
  age: z.number(),
  email: z.string().optional(),   // 可选字段
})

// 数组
const listSchema = z.array(z.string())

// 联合类型
const resultSchema = z.union([z.string(), z.number()])
// 或者：z.string().or(z.number())
```

### 校验数据

```typescript
// parse：校验失败时抛出异常
const user = userSchema.parse({ name: "Alice", age: 25 })

// safeParse：校验失败时返回错误对象（不抛异常）
const result = userSchema.safeParse(badData)
if (result.success) {
  const user = result.data   // 校验成功
} else {
  console.error(result.error)  // 错误信息
}
```

### 推断类型

这是 Zod 最强大的功能：

```typescript
const userSchema = z.object({
  name: z.string(),
  age: z.number(),
})

// 从 schema 自动推断 TypeScript 类型
type User = z.infer<typeof userSchema>
// 等价于：type User = { name: string; age: number }
```

**一次定义，两用**：运行时校验 + 编译时类型，不重复写。

---

## 在 Claude Code 里的实际应用

### BashTool 的输入 schema

**文件：[src/tools/BashTool/BashTool.tsx](../src/tools/BashTool/BashTool.tsx#L227-L247)**

```typescript
const fullInputSchema = lazySchema(() => z.strictObject({
  // 必填：要执行的命令
  command: z.string().describe('The command to execute'),

  // 可选：超时时间（毫秒）
  timeout: semanticNumber(z.number().optional())
    .describe(`Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`),

  // 可选：命令描述（给用户看的）
  description: z.string().optional()
    .describe(`Clear, concise description of what this command does...`),

  // 可选：是否在后台运行
  run_in_background: semanticBoolean(z.boolean().optional())
    .describe(`Set to true to run this command in the background.`),

  // 可选：禁用沙盒（危险操作）
  dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional())
    .describe('Set this to true to dangerously override sandbox mode...'),
}))
```

这个 schema 做了两件事：
1. **运行时校验**：Claude 发来的参数必须符合这个形状，不然报错
2. **给 LLM 看的文档**：`.describe()` 的内容会被转换成 JSON Schema 发给 Claude，告诉它这个工具接受什么参数

### 从 schema 推断类型

**文件：[src/tools/BashTool/BashTool.tsx](../src/tools/BashTool/BashTool.tsx#L264)**

```typescript
export type BashToolInput = z.infer<ReturnType<typeof fullInputSchema>>
// BashToolInput 自动包含所有字段的类型
// { command: string; timeout?: number; description?: string; ... }
```

### 使用 safeParse 在工具校验里

**文件：[src/tools/BashTool/BashTool.tsx](../src/tools/BashTool/BashTool.tsx#L470-L476)**

```typescript
const parsed = inputSchema().safeParse(input)
// safeParse 不抛异常——工具收到 LLM 的参数后先校验
// 如果格式不对，返回错误而不是崩溃
```

---

## `.describe()` 的特殊意义

在 Web 开发里，你可能没见过 schema 里加这么多描述文字。在 AI 工具里，这非常关键：

```
Zod schema
    │
    ▼ 转换
JSON Schema（带 description 字段）
    │
    ▼ 发给
Claude（LLM）
```

Claude 通过 JSON Schema 知道工具的参数格式，通过 `description` 知道每个参数的含义。**没有 description，Claude 可能传错参数；有了 description，Claude 知道怎么填。**

---

## `.strictObject()` vs `.object()`

注意 BashTool 用的是 `z.strictObject`，不是 `z.object`：

```typescript
// z.object：允许传入额外字段（会被忽略）
z.object({ name: z.string() }).parse({ name: "Alice", extra: 123 })  // ✅

// z.strictObject：不允许额外字段
z.strictObject({ name: z.string() }).parse({ name: "Alice", extra: 123 })  // ❌ 报错
```

`strictObject` 更安全——防止 LLM 传入项目未预期的字段，避免奇怪的行为。

---

## Zod 的链式调用

Zod 支持方法链，每个方法返回一个新的 schema：

```typescript
z.string()
  .min(1, "不能为空")        // 最短 1 个字符
  .max(100, "不能超过100字")  // 最长 100 个字符
  .email("格式不对")          // 必须是 email 格式

z.number()
  .int("必须是整数")
  .positive("必须是正数")
  .max(1000)

z.array(z.string())
  .nonempty("数组不能为空")
  .max(10, "最多10个元素")
```

---

## 为什么不直接用 TypeScript 类型？

这个问题值得再强调一下：

| | TypeScript 类型 | Zod schema |
|--|----------------|-----------|
| 编译时类型检查 | ✅ | ✅（通过 `z.infer`） |
| 运行时数据校验 | ❌ | ✅ |
| 生成 JSON Schema | ❌ | ✅（供 LLM 使用） |
| 错误信息 | 编译错误 | 运行时详细错误 |
| 适合场景 | 内部代码 | 外部数据（LLM 输出、用户输入、API 响应） |

在 Claude Code 里，工具参数来自 LLM，是"外部数据"，必须用 Zod 做运行时校验。

---

## 本节小结

- TypeScript 类型只在编译时存在，运行时无法保护外部数据
- Zod 提供运行时 schema 校验，`parse()` 失败抛异常，`safeParse()` 返回错误对象
- `z.infer<typeof schema>` 从 schema 推断 TypeScript 类型，一次定义两用
- `.describe()` 方法的内容会转换为 JSON Schema 发给 LLM，是工具文档的核心
- `strictObject` 比 `object` 更严格，不允许额外字段

## 前后呼应

- 本节的 Zod schema，在 **[7-2 节](./7-2-Tool接口的设计.md)** 讲工具接口设计时会看到 `inputSchema` 字段的完整定义
- 本节的 JSON Schema 转换，在 **[5-3 节](./5-3-工具调用的完整协议.md)** 讲工具调用协议时会看到它如何发给 LLM

## 下一节预告

第 2 章结束了。接下来是最重要的前置知识：**异步编程深入**。Claude Code 的核心是一个 AsyncGenerator，理解它需要先从最基础的"JavaScript 为什么是单线程"说起。

➡️ [下一节：3-1 为什么 JavaScript 是单线程的](./3-1-为什么JavaScript是单线程的.md)
