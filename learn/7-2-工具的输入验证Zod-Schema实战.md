# 7-2 工具的输入验证：Zod Schema 实战

> **本节目标**：Claude 请求调用工具时，传来的是 JSON——一个可以是任意形状的对象。工具需要验证这个 JSON 是否合法。Claude Code 用 Zod 做这件事。为什么用 Zod？怎么用？`buildTool()` 是什么？这节课通过 BashTool 的真实代码来回答这些问题。

---

## 问题：工具收到的是原始 JSON

当 Claude 请求调用 `Bash` 工具时，发来的是：

```json
{
  "type": "tool_use",
  "id": "toolu_01abc",
  "name": "Bash",
  "input": {
    "command": "ls -la",
    "timeout": 30000
  }
}
```

`input` 字段是 `Record<string, unknown>`——任何形状的 JSON 对象。

工具需要：
1. **验证** `command` 字段存在且是字符串
2. **验证** `timeout` 如果存在，必须是数字
3. **转换** 某些字段（比如把字符串 `"true"` 转成布尔 `true`）
4. **报错** 如果参数非法，给出清晰的错误信息

最重要的是：这些验证规则**必须和发给 Claude 的 JSON Schema 一致**。因为 Claude 是按照 JSON Schema 来构造参数的——如果 Schema 说 `timeout` 是可选的，Claude 就可能不传；如果你的代码却 assert `timeout` 一定有值，就会崩溃。

---

## 朴素方案：手写类型检查

```typescript
// ❌ 朴素方案：手写类型检查
function callBash(input: unknown) {
  if (typeof input !== 'object' || input === null) {
    throw new Error('input must be an object')
  }
  const obj = input as Record<string, unknown>
  
  if (typeof obj.command !== 'string') {
    throw new Error('command must be a string')
  }
  if (obj.timeout !== undefined && typeof obj.timeout !== 'number') {
    throw new Error('timeout must be a number if provided')
  }
  
  // 还需要生成 JSON Schema 给 Claude 看...
  // 还需要 TypeScript 类型给 call() 函数使用...
  // 这三件事要保持同步！
}
```

**问题**：验证逻辑、JSON Schema、TypeScript 类型三者完全分离，很容易不同步。

改了一处，忘了改另外两处，只能靠运行时错误发现。

---

## Zod 的解法：一个 Schema，三件事全搞定

Zod 是一个运行时类型验证库。它的核心思想是：**用一个 Schema 对象同时描述验证规则、JSON Schema 和 TypeScript 类型**。

```typescript
import { z } from 'zod/v4'

const inputSchema = z.object({
  command: z.string(),            // 必须是字符串
  timeout: z.number().optional(), // 可选数字
})

// 1. 类型推断（编译时）
type Input = z.infer<typeof inputSchema>
// = { command: string; timeout?: number }

// 2. 运行时验证
const result = inputSchema.safeParse(rawInput)
if (result.success) {
  result.data  // 类型是 Input，已验证
} else {
  result.error  // Zod 的详细错误信息
}

// 3. 生成 JSON Schema（通过 zodToJsonSchema 或 Zod v4 的内置方法）
// → { type: "object", properties: { command: { type: "string" }, ... } }
```

一个 Schema，自动保持三者同步。

---

## BashTool 的真实 Schema

**文件：[src/tools/BashTool/BashTool.tsx](../src/tools/BashTool/BashTool.tsx#L227-L247)**

```typescript
const fullInputSchema = lazySchema(() => z.strictObject({
  command: z.string().describe('The command to execute'),
  
  timeout: semanticNumber(z.number().optional()).describe(
    `Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`
  ),
  
  description: z.string().optional().describe(`
    Clear, concise description of what this command does...
    For simple commands, keep it brief (5-10 words):
    - ls → "List files in current directory"
  `),
  
  run_in_background: semanticBoolean(z.boolean().optional()).describe(
    `Set to true to run this command in the background.`
  ),
  
  dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()),
  
  // 内部字段——不会暴露给 Claude
  _simulatedSedEdit: z.object({
    filePath: z.string(),
    newContent: z.string()
  }).optional(),
}))
```

这里有几个值得注意的细节：

### `lazySchema(() => ...)` 的作用

把 Schema 包在一个函数里延迟创建，而不是在模块加载时立即执行。

为什么？

```typescript
timeout: semanticNumber(z.number().optional()).describe(
  `Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`
  //                                            ↑ 这个函数调用在模块加载时运行
)
```

`getMaxTimeoutMs()` 读取配置来决定最大超时时间。模块加载时配置可能还没初始化，用 `lazySchema` 把创建延迟到第一次访问时。

### `z.strictObject()` vs `z.object()`

`strictObject` 不允许额外字段——如果 Claude 传了 Schema 里没定义的字段，会报错。

普通 `object` 会忽略额外字段。用 `strictObject` 是更安全的选择：防止 Claude 意外传入无效参数被默默忽略。

### `.describe(...)` 的作用

`.describe()` 添加的描述字符串会被 Zod 放进生成的 JSON Schema 里，变成参数的 `description` 字段。

这个描述**直接发给 Claude**——Claude 读这个描述来理解如何使用这个参数。

**这就是为什么 BashTool Schema 里有这么详细的描述和例子**——这些不是给人类读的注释，是给 Claude 的使用说明。

### `semanticNumber()` 和 `semanticBoolean()`：语义转换

这两个是 Claude Code 自己的 Zod 扩展。

LLM 有时候会把数字以字符串形式传入（`"30000"` 而不是 `30000`），把布尔以字符串形式传入（`"true"` 而不是 `true`）。

`semanticNumber()` 和 `semanticBoolean()` 在验证之前做类型转换——把字符串的数字/布尔转成正确类型，而不是直接报错。

---

## inputSchema vs fullInputSchema

注意有两个 Schema：

```typescript
// fullInputSchema：完整版，包含内部字段 _simulatedSedEdit
const fullInputSchema = lazySchema(() => z.strictObject({
  command: ...,
  timeout: ...,
  _simulatedSedEdit: z.object(...).optional(),  // 内部字段
}))

// inputSchema：对外版，剔除内部字段
const inputSchema = lazySchema(() =>
  isBackgroundTasksDisabled
    ? fullInputSchema().omit({ run_in_background: true, _simulatedSedEdit: true })
    : fullInputSchema().omit({ _simulatedSedEdit: true })
)
```

**为什么需要两个**？

`_simulatedSedEdit` 是内部字段——当用户批准了一个 sed 编辑操作，Claude Code 会把预计算的结果放在这个字段里，然后重新调用工具。

如果把这个字段暴露在发给 Claude 的 JSON Schema 里，Claude 就能直接设置它，绕过权限检查——安全漏洞。

所以：
- `fullInputSchema`：工具代码内部用，包含 `_simulatedSedEdit`
- `inputSchema`：发给 Claude 用，剔除内部字段

这是一个很实用的安全设计：**通过 Schema 的形状来控制 Claude 能看到什么、能设置什么**。

---

## `buildTool()`：工具的工厂函数

**文件：[src/Tool.ts](../src/Tool.ts#L783-L791)**

```typescript
export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,  // 填入默认值
    userFacingName: () => def.name,
    ...def,            // 用 def 里的值覆盖默认值
  } as BuiltTool<D>
}
```

`buildTool()` 做的事很简单——把默认值和你提供的定义合并。

默认值（`TOOL_DEFAULTS`）是：

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,              // 默认启用
  isConcurrencySafe: () => false,     // 默认不并发安全（保守）
  isReadOnly: () => false,            // 默认假设会写文件（保守）
  isDestructive: () => false,         // 默认不破坏性
  checkPermissions: () => Promise.resolve({ behavior: 'allow' }),  // 默认允许
  toAutoClassifierInput: () => '',    // 默认跳过自动分类器
}
```

**为什么所有安全相关的默认值都是"保守"的（假设不安全）？**

这是 Fail-Closed 原则——如果忘了实现某个方法，宁可过度保护也不要暴露安全漏洞。

比如 `isConcurrencySafe: () => false`——如果一个工具没有声明自己是并发安全的，系统就假设它不是，避免并发执行引发竞争条件。

---

## BashTool 的完整 buildTool 调用

**文件：[src/tools/BashTool/BashTool.tsx](../src/tools/BashTool/BashTool.tsx#L420)**

```typescript
export const BashTool = buildTool({
  name: BASH_TOOL_NAME,           // 'Bash'
  searchHint: 'execute shell commands',
  maxResultSizeChars: 30_000,     // 超出 30K 就持久化到磁盘
  strict: true,                   // 严格模式（Claude 必须精确匹配 Schema）
  
  inputSchema,                    // 上面定义的对外 Schema
  
  async description(input, { isNonInteractiveSession, toolPermissionContext }) {
    // 动态描述：根据当前权限模式调整说明
    const baseDesc = `Execute bash command...`
    if (toolPermissionContext.mode === 'bypassPermissions') {
      return baseDesc + '\n\nPermissions: Bypassed.'
    }
    return baseDesc
  },
  
  isReadOnly: () => false,          // 显式声明：Bash 不是只读的
  isConcurrencySafe: () => true,    // Bash 命令可以并发执行（每个都是独立进程）
  isDestructive: (input) => {
    // 检查命令是否是危险操作（rm -rf 等）
    return isDestructiveCommand(input.command)
  },
  
  async call(input, context, canUseTool) {
    // 执行 Bash 命令的核心逻辑
    // input 已经经过 Schema 验证，有正确的 TypeScript 类型
    const { command, timeout, run_in_background } = input
    // ...
  }
})
```

注意 `isConcurrencySafe: () => true`——Bash 工具声明自己是并发安全的。这意味着如果 Claude 同时请求调用多个 `Bash` 工具（比如并行分析多个文件），Claude Code 可以真正并行执行，而不是串行。

---

## Zod Schema 如何变成 JSON Schema 发给 Claude

工具的 `inputSchema` 是 Zod 对象，但 Anthropic API 需要 JSON Schema 格式。

这个转换发生在 `assembleToolPool()` 里（下一节会讲）：

```typescript
// 简化版
function zodToJsonSchema(zodSchema: z.ZodTypeAny): ToolInputJSONSchema {
  // Zod v4 内置了 toJSONSchema() 方法
  return zodSchema.toJSONSchema()
}
```

最终发给 Claude 的工具定义长这样：

```json
{
  "name": "Bash",
  "description": "Execute bash command...",
  "input_schema": {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "description": "The command to execute"
      },
      "timeout": {
        "type": "number",
        "description": "Optional timeout in milliseconds..."
      }
    },
    "required": ["command"]
  }
}
```

Claude 看到这个 JSON Schema，知道 `command` 是必填的字符串，`timeout` 是可选的数字，然后按照这个格式构造参数。

---

## 本节小结

- Zod 的核心价值：一个 Schema 同时提供运行时验证、TypeScript 类型推断、JSON Schema 生成，保证三者不会不同步
- `lazySchema(() => ...)` 延迟 Schema 创建，避免模块加载时依赖未初始化的配置
- `z.strictObject()` 比 `z.object()` 更安全，不允许额外字段
- `.describe()` 的字符串直接作为参数说明发给 Claude，是给 Claude 看的，不是给人类看的注释
- `inputSchema` vs `fullInputSchema`：通过两个 Schema 控制 Claude 能看到什么字段（安全隔离）
- `buildTool()` 合并默认值，默认值遵循 Fail-Closed 原则

## 前后呼应

- 本节的 Zod `.describe()` 字符串，是 **[8-3 节](./8-3-System-Prompt的构建.md)** 里工具说明的组成部分
- 本节的 `isConcurrencySafe`，在 **[9-6 节](./9-6-并发工具执行Promise-all策略.md)** 会看到它如何决定工具是串行还是并行执行

## 下一节预告

Schema 写好了，工具定义好了。但 Claude Code 怎么决定要把哪些工具发给 Claude？40+ 个工具全发还是按需筛选？`assembleToolPool()` 做了什么？

➡️ [下一节：7-3 工具注册表：assembleToolPool 的工作](./7-3-工具注册表assembleToolPool.md)
