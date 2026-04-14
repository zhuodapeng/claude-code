# 5-5 用 10 行代码调用一次 Anthropic API

> **本节目标**：把第 5 章所有理论变成可运行的代码。从最简单的 API 调用开始，逐步加入流式响应、工具调用，亲手体会这些概念是如何在代码里实现的。

---

## 为什么要动手写？

学了四节理论，现在必须动手——只有自己写出来，才真正理解了。

这些代码可以放在 `learn/demos/` 目录下直接运行（需要 `.env` 文件里有 API Key）。

---

## Demo 1：最简单的 API 调用（同步）

```typescript
// 文件：learn/demos/5-5-demo1-basic.ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

const message = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',  // 用 Haiku，最便宜
  max_tokens: 1024,
  messages: [
    {
      role: 'user',
      content: '用一句话解释什么是递归',
    }
  ],
})

console.log(message.content[0].text)
// 输出类似：递归是一种函数调用自身的技术，用于解决可以被分解为更小的同类子问题的任务。
```

**运行方式**：
```bash
bun --env-file=.env learn/demos/5-5-demo1-basic.ts
```

**注意**：这是同步等待完整响应的方式——等几秒才看到输出。

---

## Demo 2：流式响应

```typescript
// 文件：learn/demos/5-5-demo2-streaming.ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

// 使用 stream() 而不是 create()
const stream = client.messages.stream({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 1024,
  messages: [
    {
      role: 'user',
      content: '数一下 1 到 10，每个数字解释它为什么有趣',
    }
  ],
})

// for await 逐事件处理
for await (const event of stream) {
  if (
    event.type === 'content_block_delta' &&
    event.delta.type === 'text_delta'
  ) {
    // 每个 token 立即打印，不换行
    process.stdout.write(event.delta.text)
  }
}

// 流结束后换行
console.log('\n--- 完成 ---')
```

运行这个，你会看到文字一点点出现，而不是等待然后一次性显示。

---

## Demo 3：工具调用（手动处理循环）

这个 Demo 实现了一个简单版的"Agent"——能调用工具，把结果发回给 Claude：

```typescript
// 文件：learn/demos/5-5-demo3-tools.ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

// 工具定义
const tools: Anthropic.Tool[] = [
  {
    name: 'get_time',
    description: '获取当前时间',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'calculate',
    description: '计算数学表达式',
    input_schema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '要计算的数学表达式，如 "2 + 3 * 4"',
        },
      },
      required: ['expression'],
    },
  },
]

// 执行工具的函数（真实逻辑）
function executeTool(name: string, input: Record<string, unknown>): string {
  if (name === 'get_time') {
    return new Date().toLocaleString('zh-CN')
  }
  if (name === 'calculate') {
    try {
      // ⚠️ 注意：eval 有安全风险，这里只是演示！
      const result = eval(input.expression as string)
      return String(result)
    } catch (e) {
      return `计算失败：${e}`
    }
  }
  return '未知工具'
}

// 多轮对话循环
const messages: Anthropic.MessageParam[] = [
  {
    role: 'user',
    content: '现在几点了？另外帮我计算 123 * 456 + 789',
  },
]

// 循环直到 Claude 不再调用工具
while (true) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    tools,
    messages,
  })
  
  console.log(`\n[Claude 回复，stop_reason: ${response.stop_reason}]`)
  
  if (response.stop_reason === 'end_turn') {
    // Claude 正常结束，打印最终回复
    for (const block of response.content) {
      if (block.type === 'text') {
        console.log(block.text)
      }
    }
    break  // 退出循环
  }
  
  if (response.stop_reason === 'tool_use') {
    // Claude 想调用工具
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    
    for (const block of response.content) {
      if (block.type === 'text') {
        console.log(`[Claude 说: ${block.text}]`)
      }
      if (block.type === 'tool_use') {
        console.log(`[调用工具: ${block.name}, 参数: ${JSON.stringify(block.input)}]`)
        
        // 执行工具
        const result = executeTool(block.name, block.input as Record<string, unknown>)
        console.log(`[工具结果: ${result}]`)
        
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,   // 必须和 tool_use 的 id 匹配
          content: result,
        })
      }
    }
    
    // 把 Claude 的回复和工具结果加入历史，继续下一轮
    messages.push({
      role: 'assistant',
      content: response.content,
    })
    messages.push({
      role: 'user',
      content: toolResults,
    })
    // 继续循环，Claude 收到工具结果后会给出最终回复
  }
}
```

运行这个，你会看到完整的工具调用流程：
1. Claude 决定调用 `get_time` 和 `calculate`
2. 程序执行工具，拿到结果
3. 结果发回给 Claude
4. Claude 给出包含时间和计算结果的最终回复

**这就是 Claude Code 的 queryLoop 在做的事情，只是 Claude Code 的版本处理了流式响应、并发工具调用、错误重试等更多情况。**

---

## Demo 4：流式 + 工具调用（接近真实场景）

把流式响应和工具调用结合：

```typescript
// 文件：learn/demos/5-5-demo4-stream-tools.ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

const messages: Anthropic.MessageParam[] = [
  { role: 'user', content: '现在是几点？用中文回答' }
]

const tools: Anthropic.Tool[] = [
  {
    name: 'get_time',
    description: '获取当前时间',
    input_schema: { type: 'object', properties: {}, required: [] },
  }
]

while (true) {
  // 流式请求
  const stream = client.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    tools,
    messages,
  })
  
  const toolUseBlocks: Anthropic.ToolUseBlock[] = []
  let currentToolInput = ''
  let currentToolUseId = ''
  let currentToolName = ''
  
  for await (const event of stream) {
    switch (event.type) {
      case 'content_block_start':
        if (event.content_block.type === 'tool_use') {
          // 工具调用块开始
          currentToolUseId = event.content_block.id
          currentToolName = event.content_block.name
          currentToolInput = ''
          process.stdout.write(`\n[开始调用工具: ${currentToolName}]`)
        }
        break
        
      case 'content_block_delta':
        if (event.delta.type === 'text_delta') {
          // 文字 token
          process.stdout.write(event.delta.text)
        } else if (event.delta.type === 'input_json_delta') {
          // 工具参数 JSON 片段，拼接起来
          currentToolInput += event.delta.partial_json
        }
        break
        
      case 'content_block_stop':
        if (currentToolName) {
          // 工具调用块结束，记录完整的工具调用
          toolUseBlocks.push({
            type: 'tool_use',
            id: currentToolUseId,
            name: currentToolName,
            input: JSON.parse(currentToolInput || '{}'),
          })
          currentToolName = ''
        }
        break
    }
  }
  
  // 获取最终消息（流结束后可以拿到完整消息）
  const finalMessage = await stream.finalMessage()
  
  if (finalMessage.stop_reason === 'end_turn') {
    console.log('\n[结束]')
    break
  }
  
  if (finalMessage.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
    // 执行所有工具
    const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map(tool => ({
      type: 'tool_result',
      tool_use_id: tool.id,
      content: tool.name === 'get_time' ? new Date().toLocaleString('zh-CN') : '未知工具',
    }))
    
    // 更新消息历史
    messages.push({ role: 'assistant', content: finalMessage.content })
    messages.push({ role: 'user', content: toolResults })
  }
}
```

---

## 从这些 Demo 到 Claude Code 的距离

| Demo 里做的事 | Claude Code 里对应的代码 |
|-------------|------------------------|
| `client.messages.stream()` | `src/services/api/claude.ts` 的 `queryModelWithStreaming()` |
| `for await` 处理事件 | `src/query.ts` 的 `queryLoop()` 里的 `for await` 循环 |
| 收集 `tool_use` 块 | `queryLoop()` 里的 `toolUseBlocks` 数组 |
| 执行工具 | `src/services/tools/toolOrchestration.ts` 的 `runTools()` |
| 把工具结果加入历史 | `QueryEngine` 的 `mutableMessages` 更新 |
| 继续循环 | `queryLoop()` 的 `while (true)` |

**Claude Code 比这些 Demo 复杂的地方**：
- 并发执行多个工具（`Promise.all`）
- AbortController 支持取消
- 错误重试逻辑
- Token 限制和自动压缩
- 权限检查（`canUseTool`）
- 流式事件实时渲染到 TUI

---

## 本节小结

- 最简单的 API 调用：`client.messages.create()` 同步等待
- 流式调用：`client.messages.stream()` + `for await`，逐 token 处理
- 工具调用：需要手动循环，检测 `stop_reason === 'tool_use'`，执行工具，把结果加入历史继续请求
- 完整的 Agent 循环 = 流式 API + 工具调用 + 多轮历史管理
- Claude Code 的 `queryLoop` 就是生产级的这个循环

## 前后呼应

- 本节的 Demo 3 `while (true)` 工具调用循环，就是 **[9-1 节](./9-1-queryLoop的全局结构.md)** 要拆解的 `queryLoop` 的核心结构
- 本节的"收集 tool_use 块 → 执行 → 发回结果"，在 **[9-5 节](./9-5-tool-use事件Claude要用工具了.md)** 和 **[9-7 节](./9-7-工具结果如何喂回给Claude.md)** 会看到真实实现

## 下一节预告

下一节讲**模型参数**——`temperature`、`max_tokens`、Fast 模式是什么？这些参数如何影响 Claude 的回复质量和速度？

➡️ [下一节：5-6 模型参数：temperature、max_tokens、Fast 模式](./5-6-模型参数与Fast模式.md)
