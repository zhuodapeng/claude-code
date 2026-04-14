# 18-5 第四步：加入 Ink TUI

## 目标

用 React + Ink 替换 `process.stdout.write`，获得一个真正的终端 UI：

- 用户输入区和输出区视觉分离
- LLM 思考时显示 spinner
- 工具调用以醒目格式展示
- 消息历史可以滚动查看

---

## 为什么要用 React 渲染终端

在 step3，我们用 `process.stdout.write` 直接写字节到终端。这很简单，但有限制：

**问题 1：无法"修改"已打印的内容**
如果 LLM 在流式输出过程中需要更新 spinner（"思考中..." → "调用工具..."），你无法修改之前打印的内容，只能追加。

**问题 2：状态和 UI 混在一起**
`ask()` 函数既处理业务逻辑又操作终端输出。越来越难以维护。

**React + Ink 的解法**：

- **状态和视图分离**：状态（`messages`, `isLoading` 等）放在 React state 里，视图（组件）只负责渲染
- **声明式 UI**：只需描述"当前状态下应该长什么样"，Ink 负责计算哪些行需要更新
- **可以"修改"已渲染的内容**：Ink 通过 ANSI 转义码实现部分刷新

这正是 Claude Code 选择 React + Ink 的原因（我们在第 4 章讲过）。

---

## 安装依赖

```bash
bun add ink react
bun add -d @types/react
```

---

## 应用状态设计

先设计状态结构，这是 Ink TUI 的核心：

```typescript
interface AppState {
  // 消息历史（用于展示）
  displayMessages: DisplayMessage[]

  // 当前状态
  status: 'idle' | 'thinking' | 'tool-running' | 'error'

  // 当前正在执行的工具名（status === 'tool-running' 时有值）
  currentTool?: string

  // 流式输出中的当前文字
  streamingText: string
}

interface DisplayMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
}
```

---

## 完整代码：step4.tsx

```typescript
// step4.tsx - 加入 Ink TUI
import React, { useState, useCallback } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import Spinner from 'ink-spinner'
import Anthropic from '@anthropic-ai/sdk'
import * as fs from 'fs/promises'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// ======= 工具定义 =======
const TOOLS: Anthropic.Tool[] = [
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

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
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

// ======= 消息展示类型 =======
type DisplayMessage =
  | { type: 'user'; content: string }
  | { type: 'assistant'; content: string }
  | { type: 'tool'; toolName: string; input: string; result?: string }

// ======= 主组件 =======
function App() {
  const { exit } = useApp()
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // API 消息历史（用于 API 调用）
  const [apiMessages, setApiMessages] = useState<Anthropic.MessageParam[]>([])

  // 展示消息（用于渲染）
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([])

  // 当前状态
  const [status, setStatus] = useState<'idle' | 'thinking' | 'tool-running'>('idle')
  const [currentTool, setCurrentTool] = useState('')
  const [streamingText, setStreamingText] = useState('')

  // 输入框
  const [input, setInput] = useState('')

  // ======= 键盘输入处理 =======
  useInput((inputChar, key) => {
    if (status !== 'idle') return  // 处理中不响应输入

    if (key.return) {
      // 回车：提交问题
      if (input.trim()) {
        handleSubmit(input.trim())
        setInput('')
      }
    } else if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1))
    } else if (key.ctrl && inputChar === 'c') {
      exit()
    } else if (inputChar && !key.ctrl && !key.meta) {
      setInput(prev => prev + inputChar)
    }
  })

  // ======= 提交处理 =======
  const handleSubmit = useCallback(async (userInput: string) => {
    // 1. 展示用户消息
    setDisplayMessages(prev => [...prev, { type: 'user', content: userInput }])

    // 2. 加入 API 消息历史
    const newApiMessages: Anthropic.MessageParam[] = [
      ...apiMessages,
      { role: 'user', content: userInput },
    ]
    setApiMessages(newApiMessages)

    setStatus('thinking')
    setStreamingText('')

    try {
      await runLoop(newApiMessages)
    } catch (e) {
      setDisplayMessages(prev => [...prev, { type: 'assistant', content: `Error: ${e}` }])
    } finally {
      setStatus('idle')
      setStreamingText('')
    }
  }, [apiMessages])

  // ======= 核心循环（独立函数，因为需要 setApiMessages） =======
  const runLoop = async (currentMessages: Anthropic.MessageParam[]) => {
    let loopMessages = [...currentMessages]

    while (true) {
      const stream = await client.messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 8096,
        tools: TOOLS,
        messages: loopMessages,
      })

      let accumulatedText = ''
      const toolCallAccumulators = new Map<number, { id: string; name: string; inputJson: string }>()

      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          toolCallAccumulators.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: '',
          })
        }
        else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            accumulatedText += event.delta.text
            setStreamingText(accumulatedText)
          } else if (event.delta.type === 'input_json_delta') {
            const acc = toolCallAccumulators.get(event.index)
            if (acc) acc.inputJson += event.delta.partial_json
          }
        }
      }

      const finalMessage = await stream.finalMessage()

      if (finalMessage.stop_reason === 'end_turn') {
        // 完成：把流式文字变为正式消息
        setDisplayMessages(prev => [...prev, { type: 'assistant', content: accumulatedText }])
        loopMessages = [...loopMessages, { role: 'assistant', content: finalMessage.content }]
        setApiMessages(loopMessages)
        setStreamingText('')
        return
      }

      if (finalMessage.stop_reason === 'tool_use') {
        // 先记录 LLM 的助手消息
        if (accumulatedText) {
          setDisplayMessages(prev => [...prev, { type: 'assistant', content: accumulatedText }])
          setStreamingText('')
        }
        loopMessages = [...loopMessages, { role: 'assistant', content: finalMessage.content }]

        const toolUseBlocks = finalMessage.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
        )
        const toolResults: Anthropic.ToolResultBlockParam[] = []

        for (const block of toolUseBlocks) {
          setStatus('tool-running')
          setCurrentTool(block.name)

          // 展示工具调用（无结果状态）
          const toolDisplayIdx = displayMessages.length  // 记录位置
          setDisplayMessages(prev => [...prev, {
            type: 'tool',
            toolName: block.name,
            input: JSON.stringify(block.input),
          }])

          const result = await executeTool(block.name, block.input as Record<string, unknown>)

          // 更新工具展示（加上结果）
          setDisplayMessages(prev => {
            const next = [...prev]
            const toolMsg = next.find(
              m => m.type === 'tool' && m.toolName === block.name && !m.result
            )
            if (toolMsg && toolMsg.type === 'tool') {
              toolMsg.result = result.slice(0, 500) + (result.length > 500 ? '...' : '')
            }
            return next
          })

          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
        }

        loopMessages = [...loopMessages, { role: 'user', content: toolResults }]
        setStatus('thinking')
        setCurrentTool('')
        accumulatedText = ''
      }
    }
  }

  // ======= 渲染 =======
  return (
    <Box flexDirection="column" padding={1}>
      {/* 消息历史 */}
      {displayMessages.map((msg, i) => (
        <Box key={i} marginBottom={1} flexDirection="column">
          {msg.type === 'user' && (
            <Box>
              <Text bold color="cyan">You: </Text>
              <Text>{msg.content}</Text>
            </Box>
          )}
          {msg.type === 'assistant' && (
            <Box>
              <Text bold color="green">Claude: </Text>
              <Text wrap="wrap">{msg.content}</Text>
            </Box>
          )}
          {msg.type === 'tool' && (
            <Box flexDirection="column" borderStyle="single" borderColor="yellow" padding={0}>
              <Text color="yellow">⚙ {msg.toolName}: {msg.input}</Text>
              {msg.result && <Text dimColor>{msg.result}</Text>}
            </Box>
          )}
        </Box>
      ))}

      {/* 流式文字（正在生成中）*/}
      {streamingText && (
        <Box>
          <Text bold color="green">Claude: </Text>
          <Text wrap="wrap">{streamingText}</Text>
        </Box>
      )}

      {/* 状态指示器 */}
      {status === 'thinking' && !streamingText && (
        <Box>
          <Text color="green"><Spinner type="dots" /></Text>
          <Text> Thinking...</Text>
        </Box>
      )}
      {status === 'tool-running' && (
        <Box>
          <Text color="yellow"><Spinner type="dots" /></Text>
          <Text> Running {currentTool}...</Text>
        </Box>
      )}

      {/* 输入框 */}
      <Box borderStyle="single" marginTop={1}>
        <Text bold color="cyan">You: </Text>
        <Text>{input}<Text inverse> </Text></Text>
      </Box>
    </Box>
  )
}

// ======= 入口 =======
render(<App />)
```

---

## 关键设计：两套"消息"

你会注意到我们有两个消息列表：

```typescript
const [apiMessages, setApiMessages] = useState<Anthropic.MessageParam[]>([])
const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([])
```

为什么需要分开？

- **apiMessages**：必须完全符合 Anthropic API 的格式，包含工具调用结构、tool_result 块等。这是给 API 用的。
- **displayMessages**：用于渲染 UI，格式更简单，可以包含我们自定义的字段（比如工具结果的截断预览）。

Claude Code 也是这样分开的：[src/core/messageStorage.ts](../src/core/messageStorage.ts) 管理 API 格式的消息历史，[src/ui/components/Messages.tsx](../src/ui/components/Messages.tsx) 管理展示格式。两套格式在不同场景下分别使用，不互相污染。

---

## Ink 的核心特性：声明式终端渲染

```typescript
// 声明式 UI：描述"当前应该长什么样"
return (
  <Box flexDirection="column">
    {status === 'thinking' && <Spinner />}
    {displayMessages.map(msg => <MessageRow key={...} msg={msg} />)}
    <InputBox value={input} />
  </Box>
)
```

当 `setStatus('tool-running')` 被调用时，React 重新渲染，spinner 变成不同样式——不需要手动计算"哪些终端行需要更新"，Ink 帮你做了。

这正是第 4 章讲的 Ink 的核心价值。

---

## 对应 Claude Code 的哪些部分

| 我们的代码 | Claude Code 对应 |
|-----------|----------------|
| `App` 组件 | `src/components/App.tsx` |
| `apiMessages` state | AppState 中的 messages 数组 |
| `displayMessages` state | 渲染组件用的消息格式 |
| `useInput()` | Ink 的键盘输入处理 |
| `<Spinner />` | Claude Code 里的 loading 指示器 |
| `streamingText` state | 流式 token 的实时累积状态 |

---

## 本章小结

Ink TUI 带来的变化：
1. 状态（apiMessages、displayMessages）和视图（JSX 组件）完全分离
2. 声明式渲染：状态变化自动驱动 UI 更新
3. `useInput()` 统一处理键盘输入
4. 两套消息格式：API 格式 vs 展示格式

## 下一节预告

现在的工具调用没有任何安全防护——LLM 说什么就执行什么。下一步加入权限系统：危险操作先问用户。

➡️ [下一节：18-6 第五步：加入权限系统](./18-6-第五步加入权限系统.md)
