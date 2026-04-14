# 18-2 第一步：50 行实现最简 LLM CLI

## 目标

写一个能用的 LLM 命令行聊天工具，要求：
- 用户输入问题，LLM 回答
- 支持多轮对话（有上下文记忆）
- 不超过 50 行

不需要工具调用，不需要流式，不需要 TUI。能跑，能对话，就是成功。

---

## 完整代码

新建文件 `src/step1.ts`：

```typescript
// step1.ts - 50 行实现最简 LLM CLI
import Anthropic from '@anthropic-ai/sdk'
import * as readline from 'readline'

// ======= 核心状态：消息历史 =======
// 这是整个系统最重要的状态
// 所有的"上下文记忆"都存在这个数组里
type Message = {
  role: 'user' | 'assistant'
  content: string
}
const messages: Message[] = []

// ======= API 客户端 =======
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

// ======= 核心函数：向 LLM 提问 =======
async function ask(userInput: string): Promise<string> {
  // 1. 把用户消息加入历史
  messages.push({ role: 'user', content: userInput })

  // 2. 把完整消息历史发给 LLM
  const response = await client.messages.create({
    model: 'claude-opus-4-6',    // 使用最新模型
    max_tokens: 8096,
    messages: messages,
  })

  // 3. 提取 LLM 的回答（取第一个 text block）
  const assistantMessage = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')

  // 4. 把 LLM 回答加入历史（下次对话会包含它）
  messages.push({ role: 'assistant', content: assistantMessage })

  return assistantMessage
}

// ======= 主循环：读取输入，调用 ask，打印结果 =======
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  console.log('LLM CLI ready. Type your message (Ctrl+C to exit).\n')

  // readline 的异步迭代 API：每次迭代等一行输入
  for await (const line of rl) {
    if (!line.trim()) continue   // 忽略空行

    const answer = await ask(line)
    console.log('\nAssistant:', answer, '\n')
  }
}

main().catch(console.error)
```

运行：
```bash
ANTHROPIC_API_KEY=your-key bun src/step1.ts
```

---

## 逐行理解

### 为什么 messages 是模块级变量？

```typescript
const messages: Message[] = []
```

这是刻意的简化。第一版的程序里，消息历史是全局的、可变的数组。

你可能觉得这不"优雅"——应该封装成类，或者用函数式风格避免全局状态。

但在第一步，这样做是对的。理由：

1. **可见性**：全局变量在任何地方都能看到，调试时直接 `console.log(messages)` 就能看到完整对话历史
2. **简单**：不需要依赖注入、不需要 Context、不需要 useRef——就一个数组
3. **对应 Claude Code 的设计**：Claude Code 的消息历史也是集中管理的（AppState），只不过它的包装更复杂，但本质思路是一样的

后面当我们需要多个 Agent 并发时，再考虑怎么隔离它们的消息历史。

### 为什么每次调用 API 都把整个消息历史发过去？

```typescript
messages: messages,   // 发送完整历史
```

这是 Anthropic API 的工作方式，也是所有现代 LLM API 的工作方式：**模型本身是无状态的**。

每次 API 调用都是独立的——模型不记得上一次你问了什么。你需要手动把整个对话历史发过去，模型才能"记得"之前的上下文。

这意味着：

- 对话越长，每次 API 调用的 token 成本越高（因为历史在增长）
- 超过模型的上下文窗口限制，就会出错
- Claude Code 的 AutoCompact（第 13 章）就是为了解决这个问题

### for await...of readline

```typescript
for await (const line of rl) {
```

这是 Node.js readline 的异步迭代器 API。它比回调风格的 `rl.on('line', ...)` 更简洁，配合 `async/await` 可以写出顺序执行的代码：

```
等待输入 → 处理输入 → 等待下一行输入 → ...
```

而不是嵌套的回调：

```javascript
// 回调风格（避免）
rl.on('line', async (line) => {
  const answer = await ask(line)
  console.log(answer)
  // 这里不能 await 下一行，因为事件是并发的
})
```

---

## 对应 Claude Code 的哪些部分

这 50 行代码实现了 Claude Code 里以下模块的最简版本：

| 我们的代码 | Claude Code 对应部分 |
|-----------|---------------------|
| `messages: Message[]` | AppState 中的 `messages` 数组 |
| `ask()` | `queryLoop()` 的核心骨架 |
| `client.messages.create()` | `src/api/claude.ts` 的 API 调用 |
| `for await (const line of rl)` | Ink TUI 的用户输入处理 |

Claude Code 的实现当然复杂得多——流式响应、工具调用、权限检查……但骨架是一样的：收集消息 → 发给 API → 把回答加入消息历史 → 重复。

---

## 测试一下多轮对话是否工作

运行后，尝试这样对话：

```
You: 我的名字是 Alice
Assistant: 你好，Alice！很高兴认识你。有什么我可以帮助你的吗？

You: 我刚才说我的名字是什么？
Assistant: 你刚才说你的名字是 Alice。
```

如果 LLM 能正确回答第二个问题，说明消息历史机制工作正常——因为第二次 API 调用包含了第一轮对话的历史，LLM 能"看到"之前的内容。

---

## 这个简单版本的局限

**局限 1：不支持工具调用**
LLM 只能用自己的知识回答，不能执行代码、读文件。

**局限 2：没有流式输出**
API 调用是阻塞的——你问完问题，程序等待整个回答生成完毕，才一次性打印出来。对于长回答，这体验很差。

**局限 3：没有优雅的界面**
`console.log` 打印的输出在终端里滚动，没有区分用户输入和 LLM 输出的视觉效果。

**局限 4：上下文窗口无限增长**
消息历史只增不减。对话足够长后，超过模型的上下文限制，API 会返回错误。

我们接下来的几步会逐一解决这些问题。

---

## 本章小结

50 行代码验证了核心假设：消息历史 + Anthropic API = 多轮对话 LLM CLI。

核心模式：`push(用户消息) → API(完整历史) → push(LLM回答)` 构成了所有后续功能的基础。

## 下一节预告

第二步：加入工具调用。让 LLM 能够读文件和执行 Bash 命令，真正成为一个有用的编程助手。

➡️ [下一节：18-3 第二步：加入工具调用](./18-3-第二步加入工具调用.md)
