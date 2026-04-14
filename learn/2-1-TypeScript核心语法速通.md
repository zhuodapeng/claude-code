# 2-1 TypeScript 核心语法速通（对 Java 开发者）

> **本节目标**：快速建立 TypeScript 的语法认知——重点讲"和 Java 最不一样的地方"，让你能读懂项目代码。

---

## 为什么 TypeScript 对 Java 开发者"既熟悉又陌生"

你学过 Java，这是好事——两者都有类型系统、都是面向对象的。但 TypeScript 的类型系统有几个地方和 Java 截然不同，如果不提前说清楚，你读代码时会经常卡住。

本节聚焦这些"差异点"，不讲你已经会的部分。

---

## 差异一：类型是"可选的"，但在大型项目里是必须的

Java 里每个变量都必须声明类型。TypeScript 允许你不声明——编译器会**自动推断**：

```typescript
// Java 风格（TypeScript 也支持，但没必要）
const name: string = "claude"

// TypeScript 推断风格（更常见）
const name = "claude"         // 编译器知道这是 string
const count = 42              // 编译器知道这是 number
const tools = []              // 编译器推断为 never[]，要小心这个
```

在 Claude Code 里，你会看到大量的类型推断。只有在"编译器推断不出来"或"需要明确说明"时才写类型注解。

---

## 差异二：联合类型（Union Types）— Java 没有的概念

这是 TypeScript 里最重要也是最常用的特性之一。

```typescript
// "这个变量可以是 string，也可以是 number"
type ID = string | number

// "这个函数可能返回结果，也可能返回 null"
function findUser(id: string): User | null { ... }

// 枚举效果（用字符串字面量联合，比 Java 枚举更灵活）
type Permission = 'allow' | 'deny' | 'ask'
```

在 [src/Tool.ts](../src/Tool.ts#L95-L101) 里你能看到联合类型的实际用法：

**文件：[src/Tool.ts](../src/Tool.ts#L95-L101)**

```typescript
export type ValidationResult =
  | { result: true }                     // 校验成功：只有 result 字段
  | {
      result: false
      message: string                    // 校验失败：还有 message 和 errorCode
      errorCode: number
    }
```

这是一个**带判别式的联合类型（Discriminated Union）**：根据 `result` 字段的值，可以知道对象的形状。

用法：
```typescript
const v: ValidationResult = validate(input)

if (v.result) {
  // 这里 TypeScript 知道 v 是 { result: true }
} else {
  // 这里 TypeScript 知道 v 是 { result: false, message: string, errorCode: number }
  console.log(v.message)  // ✅ 类型安全
}
```

**Java 怎么处理这种情况？** 通常用继承：`ValidationSuccess extends ValidationResult`、`ValidationFailure extends ValidationResult`。TypeScript 的联合类型更轻量，不需要继承树。

---

## 差异三：`type` vs `interface` — 用哪个？

两个都可以定义"对象的形状"，区别很细微：

```typescript
// interface（更适合描述"对象"和"类"）
interface User {
  id: string
  name: string
}

// type（更灵活，可以做联合、交叉、条件类型）
type User = {
  id: string
  name: string
}
```

**在这个项目里**：两者都用，但 `type` 更多——因为大量使用联合类型。

规则：遇到联合类型 `A | B` 必须用 `type`；其他情况两者都行。

---

## 差异四：泛型语法更简洁

Java 泛型：`List<String>`、`Map<String, Integer>`

TypeScript 泛型：几乎一样，但语法更简洁，推断更强大。

在 [src/Tool.ts](../src/Tool.ts#L362-L366) 里：

**文件：[src/Tool.ts](../src/Tool.ts#L362-L366)**

```typescript
export type Tool<
  Input extends AnyObject = AnyObject,    // 类似 Java: <T extends SomeClass>
  Output = unknown,                        // 默认类型是 unknown
  P extends ToolProgressData = ToolProgressData,
> = {
  call(args: z.infer<Input>, ...): Promise<ToolResult<Output>>
  // ...
}
```

注意 `z.infer<Input>` 这个用法——它是从 Zod schema 类型推断出实际数据类型，第 2-3 节会专门讲。

---

## 差异五：`import type` — 仅类型导入

这是 TypeScript 特有的语法，Java 没有对应物：

```typescript
import type { Tool, ToolResult } from './Tool.js'
```

`import type` 只导入类型信息，**不会出现在编译后的 JavaScript 里**。这样做的好处：
1. 打包体积更小
2. 避免循环依赖（因为类型在运行时根本不存在）

在 [src/Tool.ts](../src/Tool.ts#L1-L13) 开头你会看到大量的 `import type`。

---

## 差异六：`?` 可选属性和 `??` 空值合并

```typescript
// 可选属性（不一定存在）
type Config = {
  timeout?: number     // number | undefined
  model: string        // 必须有
}

// 可选链调用（如果 obj 是 null/undefined，返回 undefined 而不是报错）
const name = user?.profile?.name   // 安全

// 空值合并（如果左边是 null/undefined，取右边）
const timeout = config.timeout ?? 30000  // 默认 30 秒
```

在 [src/Tool.ts](../src/Tool.ts#L401) 里可以看到：

```typescript
inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean
```

`?` 在方法名后面表示这个方法**可选**——实现 Tool 接口时不一定要实现它。

---

## 差异七：`as const` — 把值锁定为字面量类型

```typescript
// 没有 as const：TypeScript 推断为 string[]
const permissions = ['read', 'write', 'execute']

// 有 as const：推断为 readonly ['read', 'write', 'execute']
const permissions = ['read', 'write', 'execute'] as const

// 常用于对象
const config = {
  model: 'claude-opus-4-6',
  maxTokens: 8192,
} as const
// config.model 的类型是 'claude-opus-4-6'，而不是 string
```

这在工具定义、配置常量里大量使用。

---

## 差异八：`readonly` 深度不变

```typescript
type ImmutableConfig = {
  readonly model: string
  readonly tools: readonly string[]
}
```

Java 的 `final` 只能保证变量引用不变，但对象内部可以修改。TypeScript 的 `readonly` 更细粒度——可以精确到对象的每个字段。

在 [src/Tool.ts](../src/Tool.ts#L123-L138) 里的 `ToolPermissionContext` 类型用了 `DeepImmutable<...>`——一个把对象所有层级都变成 readonly 的工具类型。

---

## 快速对照表

| Java | TypeScript | 说明 |
|------|-----------|------|
| `interface Foo {}` | `interface Foo {}` 或 `type Foo = {}` | 相似 |
| `enum Color { RED, BLUE }` | `type Color = 'red' \| 'blue'` | TS 更常用字符串字面量联合 |
| `T extends Base` | `T extends Base` | 相同 |
| `List<T>` | `T[]` 或 `Array<T>` | 相同 |
| `Map<K,V>` | `Map<K,V>` 或 `Record<K,V>` | 相同 |
| `void` | `void` 或 `undefined` | 相似 |
| `Object` | `unknown` 或 `Record<string, unknown>` | TS 更严格 |
| `null` 检查（try/catch） | `x \| null` 联合类型 | TS 在类型层面强制处理 |
| `instanceof` | `instanceof` 或类型断言 | 相似 |
| `final` | `readonly` / `const` | TS 更细粒度 |

---

## 本节小结

- **联合类型** (`A | B`) 是 TypeScript 最重要的特性，替代 Java 里的继承多态
- `type` 和 `interface` 都能定义对象形状，联合类型用 `type`
- `import type` 只导入类型，不影响运行时
- `?.` 和 `??` 是安全的可选值处理方式
- `readonly` 和 `as const` 用于不可变数据

## 前后呼应

- 本节的**联合类型**概念，在 **[9-3 节](./9-3-流式响应解析逐事件处理.md)** 会看到它处理不同事件类型的实际应用
- 本节提到的 `z.infer<Input>` 泛型用法，在 **[2-3 节](./2-3-Zod运行时类型校验.md)** 会深入讲解

## 下一节预告

下一节讲函数作为"一等公民"和模块系统——这在 Claude Code 里大量使用（工具定义、回调、高阶函数），是读懂后续代码的基础。

➡️ [下一节：2-2 函数作为一等公民 + 模块系统](./2-2-函数与模块系统.md)
