# 7-1 Tool 的本质：为什么 Claude 需要工具

> **本节目标**：Claude 是语言模型，只能生成文字。那么它是怎么读取文件、执行命令、搜索代码的？这节课从根本问题出发，讲清楚"工具"这个概念在 Agent 系统里的地位，以及 Claude Code 的工具机制是怎么设计的。

---

## 从根本问题出发

你打开 Claude Code，输入："帮我分析这个项目的架构"。

Claude 怎么做到的？

语言模型（LLM）本质上是：**给定一串文字，预测下一个词**。

它不能打开文件，不能运行命令，不能访问网络。它所有的"知识"都来自训练数据——那是训练完成后就固定的。

但 Claude Code 能读文件、能跑 bash、能搜索代码。这些能力从哪里来？

答案是：**工具调用（Tool Use）**——一个让 LLM 和外部世界交互的协议。

---

## 工具调用的本质：一次协议对话

工具不是 Claude 内部的能力。工具是**程序（Claude Code）承诺提供的能力**，通过协议告诉 Claude："你可以要求我做这些事"。

整个机制是这样的：

```
第 1 步：程序发送请求时，附上工具定义列表
         "Claude，你可以用这些工具：
          - Read：读取文件（参数：file_path: string）
          - Bash：执行命令（参数：command: string）
          - Grep：搜索文件（参数：pattern: string, path: string）"

         ↓ Claude 看到这些工具定义，理解自己能做什么

第 2 步：Claude 决定需要用工具
         Claude 的回复不是文字，而是一个工具调用请求：
         { type: 'tool_use', name: 'Read', input: { file_path: 'package.json' } }

         ↓ 程序（Claude Code）收到这个请求

第 3 步：程序执行工具，把结果返回给 Claude
         { type: 'tool_result', tool_use_id: '...', content: '{ "name": "my-app" }' }

         ↓ Claude 收到工具结果，继续生成回复

第 4 步：Claude 基于工具结果给出最终回答
         "好的，package.json 里的 name 是 my-app，依赖包括..."
```

**关键认知**：工具执行发生在 Claude Code 的进程里，不在 Claude（API）里。Claude 只是"发出请求"，真正执行的是 Claude Code 的 TypeScript 代码。

这就是为什么说工具是"程序承诺的能力"——Claude Code 承诺：只要 Claude 请求调用 `Read`，我就会去读那个文件并把内容返回。

---

## 朴素方案：在 prompt 里内嵌所有信息

如果没有工具机制，要让 Claude 分析项目，只有一个办法：把所有文件内容都塞进 prompt：

```
请分析这个项目的架构。项目文件如下：
--- package.json ---
{ "name": "my-app", ... }
--- src/index.ts ---
import ...
--- src/components/App.tsx ---
...
[几百个文件的内容]
```

**为什么不行**：

1. **上下文窗口有限**：即使 Claude 有 200K token 的上下文，大型项目几十万行代码也放不下
2. **效率极差**：Claude 可能只需要看 5 个关键文件，但你把 200 个文件都塞进去
3. **实时性**：用户运行命令时，你不知道要哪些信息，只能全给

工具机制让 Claude 能**按需获取信息**——它先分析，判断需要什么，再去拿，然后再分析。

---

## Claude Code 的工具列表

Claude Code 有 40+ 个工具。按类型分：

**文件操作**：
- `Read`：读文件内容
- `Write`：创建/覆盖文件
- `Edit`：对文件做精确的字符串替换（比 Write 安全）
- `MultiEdit`：多个编辑操作合并执行
- `NotebookEdit`：编辑 Jupyter Notebook

**代码搜索**：
- `Glob`：用 glob 模式找文件（`**/*.ts`）
- `Grep`：用正则在文件内容里搜索
- `LS`：列出目录

**命令执行**：
- `Bash`：执行 shell 命令（最强大，也最危险）
- `REPL`：在持久化 JS/Python 环境里执行代码

**Web**：
- `WebFetch`：获取 URL 内容
- `WebSearch`：用搜索引擎搜索

**Agent/子任务**：
- `Agent`：启动子 Agent 完成独立子任务
- `Task`：管理后台任务

**UI 交互**：
- `AskUserQuestion`：向用户提问（需要更多信息时）
- `ExitPlanMode`、`EnterPlanMode`：在计划模式和执行模式间切换

---

## `Tool` 类型：工具的接口契约

**文件：[src/Tool.ts](../src/Tool.ts#L362-L466)**

```typescript
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
> = {
  // 工具名（Claude 用这个名字请求工具）
  readonly name: string
  
  // 是否启用（某些工具在特定条件下不可用）
  isEnabled(): boolean
  
  // 是否只读（读文件是只读，写文件不是）
  isReadOnly(input: z.infer<Input>): boolean
  
  // 是否破坏性操作（删除、覆盖）
  isDestructive?(input: z.infer<Input>): boolean
  
  // 核心：执行工具
  call(
    args: z.infer<Input>,       // 经过验证的输入参数
    context: ToolUseContext,     // 执行上下文（文件系统、状态、权限等）
    canUseTool: CanUseToolFn,    // 权限检查函数
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress,
  ): Promise<ToolResult<Output>>
  
  // 工具的输入 schema（Zod 类型）
  readonly inputSchema: Input
  
  // 工具描述（传给 Claude 的自然语言描述，告诉 Claude 这个工具能做什么）
  description(input, options): Promise<string>
  
  // 是否并发安全（可以同时运行多个实例）
  isConcurrencySafe(input: z.infer<Input>): boolean
  
  // 结果最大字符数（超出就持久化到磁盘，Claude 拿到文件路径而不是完整内容）
  maxResultSizeChars: number
}
```

注意 `description()` 函数——它是**动态的**，不是静态字符串。

为什么需要动态描述？因为同一个工具在不同的情况下，可能需要给 Claude 不同的说明：

```typescript
// BashTool 的描述根据当前会话的工作目录变化
async description(input, { toolPermissionContext }) {
  return `Execute bash command in ${getCwd()}`  
  // 告诉 Claude 当前的工作目录，让它知道相对路径的基准
}
```

---

## `ToolUseContext`：工具执行时的"世界"

`call()` 的第二个参数 `context` 是个复杂的对象，包含工具执行时需要的一切：

**文件：[src/Tool.ts](../src/Tool.ts#L158-L250)**

```typescript
export type ToolUseContext = {
  // 当前会话的配置
  options: {
    tools: Tools           // 全部工具列表（Agent 工具可以递归调用）
    mainLoopModel: string  // 使用的模型名
    commands: Command[]    // 可用的 slash 命令
    // ...
  }
  
  // 取消控制器（用户 Ctrl+C 时通知工具停止）
  abortController: AbortController
  
  // React 状态管理（工具可以更新 UI 状态）
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  
  // UI 交互
  setToolJSX?: SetToolJSXFn         // 展示自定义 React 组件
  addNotification?: (notif) => void  // 添加通知
  appendSystemMessage?: (msg) => void // 添加系统消息到对话历史
  
  // 文件状态追踪（用于检测文件是否被修改）
  readFileState: FileStateCache
  
  // 当前 Agent 身份（子 Agent 调用时不为空）
  agentId?: AgentId
}
```

这个 context 是工具和 Claude Code 主程序之间的"接口"。工具不需要知道它是在 TUI 里运行还是在 print 模式里运行——它只需要调用 `context.setToolJSX(...)` 就能展示进度界面，调用 `context.appendSystemMessage(...)` 就能往对话里插入消息。

---

## 工具和命令的区别

Claude Code 里有两个容易混淆的概念：**工具（Tool）** 和 **命令（Command/Skill）**。

| | 工具（Tool） | 命令/Skill（Command） |
|-|------------|---------------------|
| 谁调用 | Claude（通过 tool_use 协议） | 用户（在 prompt 里输入 `/xxx`） |
| 例子 | `Read`、`Bash`、`Grep` | `/commit`、`/compact`、`/diff` |
| 定义方式 | TypeScript 的 `Tool` 类型 | Markdown 文件（`.claude/commands/`） |
| 执行者 | Claude Code 进程 | Claude 自身（用 prompt 的方式） |

命令/Skill 本质上是"预定义的 prompt 模板"——当你输入 `/commit`，实际上是把一段预定好的提示词注入到对话里，然后 Claude 用它的正常工具来完成任务。

工具是更底层的能力——它直接让 Claude 和文件系统、shell 交互。

---

## 本节小结

- 工具是程序（Claude Code）承诺提供给 Claude 的能力，通过协议（tool_use → tool_result）交互
- 工具不在 Claude（API）内部执行，而是在 Claude Code 的 TypeScript 代码里执行
- `Tool` 类型定义了工具的接口：`call()`（执行）、`description()`（动态描述）、`inputSchema`（输入验证）
- `ToolUseContext` 包含工具执行所需的全部环境：状态管理、UI 交互、文件状态、取消控制
- 工具（Claude 调用）和命令（用户调用 `/xxx`）是不同层次的东西

## 前后呼应

- 本节的 tool_use → tool_result 协议，在 **[5-3 节](./5-3-流式响应SSE协议.md)** 已经介绍过其 API 形式
- 本节的 `ToolUseContext.abortController`，在 **[3-6 节](./3-6-并发控制与AbortController.md)** 讲过 AbortController 的机制

## 下一节预告

知道工具是什么了——那么工具的 `inputSchema`（Zod）具体怎么写？为什么用 Zod 而不是手写 JSON Schema？工具参数是怎么验证的？

➡️ [下一节：7-2 工具的输入验证：Zod Schema 实战](./7-2-工具的输入验证Zod-Schema实战.md)
