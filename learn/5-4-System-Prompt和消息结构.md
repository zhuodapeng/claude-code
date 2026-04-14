# 5-4 System Prompt、消息结构与多轮对话

> **本节目标**：理解 Anthropic API 的消息格式——System Prompt 的作用、消息的 role 系统、多轮对话如何通过历史消息实现，以及 Claude Code 的 System Prompt 里有什么。

---

## API 调用的完整结构

发给 Anthropic API 的请求，结构如下：

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 8192,
  "system": "...",          ← System Prompt（角色定义）
  "messages": [             ← 对话历史
    {
      "role": "user",
      "content": "..."
    },
    {
      "role": "assistant",
      "content": "..."
    },
    ...
  ],
  "tools": [...]            ← 工具定义（可选）
}
```

有三个关键部分：`system`（系统提示）、`messages`（对话历史）、`tools`（工具列表）。

---

## System Prompt 是什么

**System Prompt** 告诉 Claude "你是谁、你在什么环境下运行、你的规则是什么"。

它和 user/assistant 的对话历史是分开的——放在 `system` 字段里，不是 `messages` 里。这有一个重要含义：**System Prompt 的 Token 只算一次**（配合 Prompt Cache），不随对话轮数增长。

Claude Code 的 System Prompt 里包含什么？看一下关键函数：

**文件：[src/constants/prompts.ts](../src/constants/prompts.ts#L444-L503)**

```typescript
export async function getSystemPrompt(
  tools: Tools,
  model: string,
  additionalWorkingDirectories?: string[],
  mcpClients?: MCPServerConnection[],
): Promise<string[]> {
  // 并行获取多个系统提示段落
  const [skillToolCommands, outputStyleConfig, envInfo] = await Promise.all([
    getSkillToolCommands(cwd),     // Skills 系统的命令列表
    getOutputStyleConfig(),         // 输出风格配置
    computeSimpleEnvInfo(model, additionalWorkingDirectories),  // 环境信息
  ])
  
  const dynamicSections = [
    systemPromptSection('session_guidance', () =>
      getSessionSpecificGuidanceSection(enabledTools, skillToolCommands)
    ),   // 工作指导
    systemPromptSection('memory', () => loadMemoryPrompt()),  // 记忆注入
    systemPromptSection('env_info_simple', () =>
      computeSimpleEnvInfo(model, additionalWorkingDirectories)
    ),   // 环境信息（工作目录、系统信息等）
    systemPromptSection('language', () =>
      getLanguageSection(settings.language)
    ),   // 语言设置
    // ...更多段落
  ]
}
```

System Prompt 是**多个段落拼接而成的**，各个子系统各自贡献自己的部分：
- 基础身份定义（Claude 是谁）
- 当前工作目录
- 操作系统和环境信息
- 记忆系统注入的 MEMORY.md 内容（第 15 章）
- Skills 系统的命令列表（第 16 章）
- 语言偏好
- 工具使用规范

这种"分段式"设计让各个子系统互不耦合，每个子系统只管自己的提示词部分。

---

## 消息的 role 系统：user 和 assistant

Anthropic API 的消息只有两种角色（role）：

| Role | 含义 | 包含的内容 |
|------|------|-----------|
| `user` | 来自用户/程序的消息 | 用户输入、工具执行结果 |
| `assistant` | 来自 Claude 的消息 | Claude 的回复、工具调用请求 |

注意：**工具执行结果放在 `user` 消息里**，不是 `assistant` 里。这是因为从 API 的角度看，是"程序（用户端）"提供工具结果给 Claude。

---

## 多轮对话：LLM 本身没有记忆

这是一个关键的认知：**LLM 本身没有记忆，它不记得之前说过什么。**

每次 API 调用都是独立的——Claude 不知道上次调用发生了什么。

那为什么 Claude Code 里的 Claude 能"记住"之前的对话？

**因为每次 API 调用都把完整的历史发过去！**

```
第1轮：
  发给API：[用户:"你好"] → Claude回复:"你好！"

第2轮：
  发给API：[用户:"你好", Claude:"你好！", 用户:"你记得刚才说什么吗"]
           ↑ 包含第1轮的完整历史
  → Claude回复:"记得，你刚才说了'你好'，我回复了'你好！'"

第3轮：
  发给API：[用户:"你好", Claude:"你好！", 用户:"...记住...", Claude:"记得...", 用户:"好的"]
           ↑ 包含前两轮的完整历史
```

**历史记录越来越长** → Token 越来越多 → 这就是 Context Window 会被填满的根本原因。

---

## Claude Code 的消息类型

Claude Code 的消息比标准 API 格式更丰富，因为它有额外的内部消息类型：

**文件：[src/types/message.ts](../src/types/message.ts)**（关键类型）

```typescript
// 标准的用户消息
type UserMessage = {
  role: 'user'
  content: ContentBlock[]
}

// Claude 的回复（可能包含文字和工具调用）
type AssistantMessage = {
  role: 'assistant'
  content: ContentBlock[]
}

// Claude Code 内部用的系统消息（不发给API，只在TUI显示）
type SystemMessage = {
  type: 'system'
  content: string
  // ... 各种UI展示属性
}

// 进度消息（工具执行中的实时进度）
type ProgressMessage = {
  type: 'progress'
  data: ToolProgressData
}
```

这些消息类型有一个重要区分：**有些消息只在 TUI 显示，不会发给 API**。比如 `SystemMessage`（如"Claude 正在思考…"的提示）只是 UI 反馈，不属于对话历史。

在 `normalizeMessagesForAPI()` 函数里，Claude Code 会过滤掉这些内部消息，只把真正的对话内容发给 API。

---

## content 字段的多种形式

消息的 `content` 字段可以是字符串，也可以是内容块数组：

**纯字符串形式**（简单情况）：
```json
{
  "role": "user",
  "content": "你好！"
}
```

**内容块数组**（复杂情况）：
```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "请分析这张图："
    },
    {
      "type": "image",
      "source": {
        "type": "base64",
        "media_type": "image/png",
        "data": "..."
      }
    }
  ]
}
```

这种设计允许一条消息包含多种内容：文字+图片、文字+工具结果等。

Claude Code 里，tool_result 消息就必须是内容块数组格式（因为一条 user 消息可能包含多个工具结果）。

---

## 实际发出的 API 请求长什么样

当你在 Claude Code 里输入一条消息并等待回复时，实际发出的 API 请求大致如下：

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 8192,
  "system": [
    {
      "type": "text",
      "text": "You are Claude Code, Anthropic's official CLI for Claude...\n\nWorkdir: /your/project\nOS: macOS 15.0...\n...",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": [{ "type": "text", "text": "分析项目架构" }]
    },
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "我来读取几个关键文件..." },
        { "type": "tool_use", "id": "toolu_001", "name": "Read", "input": {"file_path": "package.json"} }
      ]
    },
    {
      "role": "user",
      "content": [
        { "type": "tool_result", "tool_use_id": "toolu_001", "content": "{ \"name\": \"claude-code-local\"...}" }
      ]
    }
  ],
  "tools": [
    { "name": "Bash", "description": "...", "input_schema": {...} },
    { "name": "Read", "description": "...", "input_schema": {...} }
    // ...40+ 个工具
  ],
  "stream": true
}
```

---

## 本节小结

- System Prompt 在独立的 `system` 字段里，定义 Claude 的角色、环境、规则
- Claude Code 的 System Prompt 由多个子系统的段落拼接而成
- 消息有 `user` 和 `assistant` 两种 role，工具结果放在 `user` 消息里
- LLM 没有记忆，多轮对话靠每次都发完整历史实现
- 历史越来越长 → Context Window 逐渐填满 → 需要压缩
- `content` 支持纯字符串和内容块数组两种形式

## 前后呼应

- 本节的 System Prompt 构建，在 **[8-3 节](./8-3-System-Prompt的构建.md)** 会深入拆解 `getSystemPrompt()` 的每个段落
- 本节的消息历史管理，在 **[10-2 节](./10-2-消息历史的生命周期.md)** 会看到 `mutableMessages` 的完整生命周期

## 下一节预告

下一节我们用 10 行代码从零调用一次 Anthropic API，把前面学的所有理论变成可运行的代码。

➡️ [下一节：5-5 用 10 行代码调用一次 Anthropic API](./5-5-用10行代码调用Anthropic-API.md)
