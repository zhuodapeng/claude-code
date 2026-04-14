# 18-8 第七步：加入子 Agent

## 目标

让主 Claude（Orchestrator）能够派发子任务给独立的 Claude 实例（Sub-Agent）并行执行，然后汇总结果。

---

## 为什么需要子 Agent

想象这个任务：
> "分析这个项目的代码质量：检查所有 TypeScript 文件，找出潜在的 bug 和性能问题"

项目里有 50 个 TypeScript 文件。一个接一个地分析是可以的，但：
- 需要很长时间
- 一个文件的分析不依赖其他文件的结果
- 这是天然的并行任务

多 Agent 的核心价值：**并行处理相互独立的子任务**。

主 Claude 决策，拆分任务，同时派发给多个子 Claude，并行分析，汇总结果。

---

## 子 Agent 的隔离原则

子 Agent 和主 Agent 的关键区别（第 14 章讲过）：

**消息历史独立**：每个子 Agent 有自己的消息历史，不和主 Agent 共享。

为什么要隔离？
- 避免上下文污染：一个子任务的中间结果不应该影响另一个子任务
- 上下文窗口独立：每个子 Agent 可以使用完整的上下文窗口
- 并发安全：多个子任务可以真正并行，不会有共享状态冲突

---

## sub_agent 工具的设计

给主 Claude 一个新工具：`run_agent`

```typescript
{
  name: 'run_agent',
  description: `启动一个子 Agent 执行独立任务。
子 Agent 有独立的上下文窗口，可以并行运行。
适用于：
- 可以独立完成的子任务
- 需要大量工具调用的任务（避免污染主上下文）
- 需要并行处理的任务集合

返回：子 Agent 的完整输出结果。`,
  input_schema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: '给子 Agent 的具体任务描述',
      },
      context: {
        type: 'string',
        description: '子 Agent 需要知道的背景信息（可选）',
      },
    },
    required: ['task'],
  },
}
```

---

## 子 Agent 的执行函数

子 Agent 本质上就是一个独立的 `queryLoop`，用全新的消息历史：

```typescript
// agents.ts

import Anthropic from '@anthropic-ai/sdk'
import * as fs from 'fs/promises'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// 子 Agent 可用的工具（可以和主 Agent 不同）
const SUB_AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: '读取文件内容',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'bash',
    description: '执行 bash 命令',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
]

async function executeSubAgentTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  if (name === 'read_file') {
    return fs.readFile(input.path as string, 'utf-8').catch(e => `Error: ${e}`)
  }
  if (name === 'bash') {
    return execAsync(input.command as string, { timeout: 30000 })
      .then(({ stdout, stderr }) => stdout + (stderr ? '\nSTDERR: ' + stderr : ''))
      .catch(e => `Error: ${e.message}`)
  }
  return `Unknown tool: ${name}`
}

// 运行子 Agent，返回最终输出
export async function runSubAgent(
  task: string,
  context?: string,
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // 子 Agent 有自己独立的消息历史
  const messages: Anthropic.MessageParam[] = []

  // 把任务和背景信息作为第一条用户消息
  const userMessage = context
    ? `背景信息：${context}\n\n任务：${task}`
    : `任务：${task}`

  messages.push({ role: 'user', content: userMessage })

  // 子 Agent 自己的 queryLoop（无 TUI，只返回文字结果）
  while (true) {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8096,
      tools: SUB_AGENT_TOOLS,
      messages,
    })

    if (response.stop_reason === 'end_turn') {
      messages.push({ role: 'assistant', content: response.content })

      // 提取文本输出
      return response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue

        const result = await executeSubAgentTool(
          block.name,
          block.input as Record<string, unknown>,
        )
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        })
      }

      messages.push({ role: 'user', content: toolResults })
    }
  }
}
```

---

## 并行运行多个子 Agent

这是子 Agent 系统的精髓：同时启动多个，等所有完成后汇总。

```typescript
// 当主 Claude 调用 run_agents（注意复数）时
if (toolName === 'run_agents') {
  const tasks = input.tasks as Array<{ task: string; context?: string }>

  // Promise.all 并行运行所有子 Agent
  const results = await Promise.all(
    tasks.map(async ({ task, context }, index) => {
      console.log(`Starting agent ${index + 1}: ${task.slice(0, 50)}...`)
      const result = await runSubAgent(task, context)
      return { task, result }
    })
  )

  // 格式化汇总结果
  return results
    .map(({ task, result }, i) => `### 子任务 ${i + 1}: ${task}\n${result}`)
    .join('\n\n---\n\n')
}
```

`Promise.all()` 是并行执行的关键——不是 `await` 一个再 `await` 下一个（串行），而是同时发起所有 API 请求，等最后一个完成。

---

## 对应 Claude Code 的 AgentTool

我们的 `run_agent` 工具对应 Claude Code 的 [src/tools/Agent/AgentTool.ts](../src/tools/Agent/AgentTool.ts)（第 14-2 节）。

Claude Code 的 AgentTool 复杂得多：

```
我们的 runSubAgent()              Claude Code 的 AgentTool.call()
        │                                      │
  独立消息历史                          独立 queryLoop() 实例
  串行工具执行                           完整工具集（所有内置工具）
  无权限系统                             权限系统（继承父级规则）
  无 UI 更新                             后台任务状态更新
  同步返回结果                            支持后台异步模式（14-5 节）
```

但核心设计是一样的：**子 Agent = 独立的消息历史 + 独立的 queryLoop**。

---

## 完整的 Orchestrator 模式

主 Claude 收到复杂任务时的思考方式（第 14-6 节 Coordinator 模式）：

```
用户："分析整个 src/ 目录，找出所有潜在的安全问题"

主 Claude（Orchestrator）：
  这个任务可以并行化：
  1. 先用 bash 找出所有 TS 文件
  2. 把文件分组，每组交给一个子 Agent 分析

  调用 bash: find src/ -name "*.ts" | head -20
  结果：[20 个文件路径]

  调用 run_agents（并行）：
    - 子 Agent 1：分析 src/core/ 下的文件（安全视角）
    - 子 Agent 2：分析 src/tools/ 下的文件（安全视角）
    - 子 Agent 3：分析 src/ui/ 下的文件（安全视角）

  等待所有子 Agent 完成...

  汇总：
  - src/core/: [子 Agent 1 的发现]
  - src/tools/: [子 Agent 2 的发现]
  - src/ui/: [子 Agent 3 的发现]
```

---

## 实现上的取舍

我们的简化版没有实现：

1. **后台异步模式**：Claude Code 支持子 Agent 在后台运行，主线程不阻塞（14-5 节）。我们的 `Promise.all` 是等所有完成后才继续。

2. **子 Agent 进度展示**：Claude Code 在 TUI 里可以展示每个子 Agent 的进度。我们只有终端 `console.log`。

3. **子 Agent 权限继承**：Claude Code 的子 Agent 继承父 Agent 的权限设置。我们的子 Agent 没有权限系统。

4. **错误隔离**：一个子 Agent 失败时，Claude Code 继续其他子 Agent。我们的 `Promise.all` 会在第一个失败时整体失败。（用 `Promise.allSettled` 可以改进）

这些都是真实系统比简化版本复杂的地方——但基本骨架是一样的。

---

## 本章小结

子 Agent 系统的核心设计：
1. **独立消息历史**：子 Agent 不和父 Agent 共享状态
2. **并行执行**：`Promise.all()` 同时运行多个子 Agent
3. **本质是递归**：子 Agent 是另一个 queryLoop 实例，可以继续调用更深层的子 Agent
4. **结果汇总**：子 Agent 完成后，结果作为工具结果返回给父 Agent

## 下一节预告

七步构建完成。最后一节，我们退一步，从全局看：如果重新设计 Claude Code，有哪些会做不同？哪些设计是优雅的，哪些是历史包袱？

➡️ [下一节：18-9 如果让我重新设计](./18-9-如果让我重新设计.md)
