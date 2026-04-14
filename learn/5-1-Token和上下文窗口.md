# 5-1 什么是 Token？Context Window 是什么意思？

> **本节目标**：从根本上理解 LLM 的"语言单位"——Token，以及 Context Window（上下文窗口）的含义和限制。这是理解为什么 Claude Code 需要"上下文压缩"（第 13 章）的基础。

---

## LLM 不处理"字符"，处理"Token"

当你给 Claude 发一段文字时，Claude 看到的不是一个个字母，而是一个个 **Token**。

Token 是 LLM 处理文本的基本单位，介于字符和单词之间。

```
你输入的文字：
"Hello, how are you?"

Claude 看到的 Token 序列（大致）：
["Hello", ",", " how", " are", " you", "?"]
```

不同语言的分词方式不同：

```
英文（效率高）：
"programming" → ["programming"]         1 个 token
"developer"   → ["developer"]           1 个 token
"tokenization" → ["token", "ization"]   2 个 token

中文（效率低）：
"你好"  → ["你", "好"]                   2 个 token
"编程"  → ["编", "程"]                   2 个 token
"ChatGPT" → ["Chat", "G", "PT"]         3 个 token

代码（效率中等）：
"function" → ["function"]               1 个 token  
"const"    → ["const"]                  1 个 token
"=>"       → ["=>"]                     1 个 token
```

**经验法则（英文）**：1 个 token ≈ 0.75 个单词，100 个 token ≈ 75 个单词。

**为什么用 Token 而不是字符？**

字符粒度太细（每个字母都是一个单元，计算量极大），单词粒度太粗（无法处理词缀、拼写变化）。Token 是实践中找到的一个平衡点。

---

## Context Window：LLM 的"短期记忆"

LLM 处理文本时，有一个根本限制：**它只能"看到"一定数量的 token**，超出这个范围的内容，它完全不知道。

这个限制叫 **Context Window（上下文窗口）**，也叫 Context Length。

类比：

> 想象你在做一道题，老师给你一张试卷（Context Window），只有这张试卷大小——超出纸张边界的内容，你看不到。
>
> - 试卷越大（Context Window 越大），你能参考的内容越多
> - 但试卷越大，读完它也越慢
> - 而且试卷大小是固定的（虽然可以放不同的内容）

Claude 的 Context Window 大小（截至 2025 年）：
- **Claude 3.5 Sonnet / Claude 3 Opus**：200K token（约 15 万个英文单词）
- **Claude Sonnet 4.6**（本项目使用）：200K token

200K token 听起来很大，但对于长时间的代码开发会话来说，很容易填满：
- 一个有 500 行的 TypeScript 文件 ≈ 3000-5000 token
- 读取 20 个文件的内容 ≈ 60,000-100,000 token  
- 加上对话历史 ≈ 很快逼近上限

---

## Context Window 里放的是什么？

每次 API 请求，Claude 收到的 Context 包含：

```
┌─────────────────────────────────────────────────────┐
│                  Context Window                      │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │           System Prompt                       │   │
│  │ （角色定义、工具描述、规则、记忆注入...）         │   │
│  │ 通常 2000-10000+ token                        │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │          对话历史（Messages）                  │   │
│  │ 用户消息 + 工具调用 + 工具结果 + Claude 回复   │   │
│  │ 每轮可能 500-50000+ token，随会话增长           │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │          当前用户消息（最新输入）               │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  剩余空间用于 Claude 的回复（Output Token）           │
└─────────────────────────────────────────────────────┘
```

**关键**：输入 Token 和输出 Token 共用 Context Window。如果输入用了 180K token，Claude 最多只能回复 20K token。

---

## Token 和费用的关系

理解 Token 还有一个很实际的原因：**API 按 Token 计费**。

```
价格（Claude Sonnet 4.6，2025年参考）：
- 输入 Token：$3 / 百万 token
- 输出 Token：$15 / 百万 token
```

一次完整的 Claude Code 会话：
- 大量读文件 → 大量输入 Token
- Claude 的回复和思考 → 输出 Token
- 总计可能消耗几万到几十万 Token

这就是 Claude Code 有"Token Budget"功能的原因——控制消耗、避免超出预算。

---

## 为什么 Context Window 会填满？

在 Claude Code 的使用场景里，Context Window 填满的速度比你想象的快：

```
会话开始：
  System Prompt：5000 token
  
第1轮：
  你："分析这个项目的架构"
  Claude：读取 README（2000 token）
  Claude：读取 5 个主要文件（15000 token）
  Claude：回复分析（3000 token）
  消耗：约 25000 token
  剩余：175000 token
  
第2轮：
  你："重构这个文件"
  Claude：读取更多文件（10000 token）
  Claude：生成重构方案（5000 token）
  消耗：约 40000 token  
  剩余：135000 token
  
...（经过多轮工具调用）...

第10轮：
  剩余：20000 token
  Claude 开始提醒 Context 快满了
```

这就是第 13 章要讲的**自动压缩（Auto Compact）**存在的原因——当 Context 快满时，自动让 Claude 总结之前的对话，删掉细节，保留关键信息，释放空间。

---

## Input Token vs Output Token

API 区分两种 Token：

**Input Token（输入 Token）**：
- System Prompt
- 对话历史（所有历史消息）
- 工具调用的结果（你读的文件内容、命令输出）
- 当前用户消息

**Output Token（输出 Token）**：
- Claude 的文字回复
- Claude 的思考过程（如果开启了 thinking 模式）
- Claude 发出的工具调用请求

**关键不对称**：输出 Token 比输入 Token 贵 5 倍！这是因为生成（推理）比读取（前向传播）计算密集得多。

---

## Cache Token：提升性能的秘密武器

Claude Code 使用了 **Prompt Cache（提示缓存）**技术：

当 System Prompt 在多次请求间保持不变时，Anthropic API 会缓存这部分 Token 的计算结果。后续请求如果前缀相同，直接复用缓存，不需要重新计算。

**效果**：
- 缓存命中：输入 Token 价格降低约 90%，延迟降低约 80%
- 每轮对话都要发送整个历史记录，但 System Prompt 不变的部分被缓存

在 Claude Code 的 API 调用里，你会看到专门的缓存控制参数：

```typescript
// src/services/api/claude.ts 里
// 特定内容块会加上 cache_control 标记
{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }
```

---

## Token 计数

Claude Code 用 Token 数量来判断何时触发压缩：

**文件：[src/utils/tokens.ts](../src/utils/tokens.ts)**

```typescript
export function tokenCountFromLastAPIResponse(response: BetaMessage): number {
  return response.usage.input_tokens + response.usage.output_tokens
}
```

API 响应里会包含本次请求消耗的 Token 数，Claude Code 记录这些数据用于：
1. 判断是否接近上下文窗口上限
2. 统计会话总消耗（显示给用户）
3. 触发自动压缩

---

## 本节小结

- Token 是 LLM 的基本处理单位，介于字符和单词之间
- Context Window 是 LLM 能"看到"的 Token 总量上限（Claude：200K）
- Context Window 包含 System Prompt、对话历史、工具结果、当前输入
- API 按 Token 计费，输出 Token 比输入贵约 5 倍
- Prompt Cache 可以缓存不变的前缀，大幅降低延迟和费用
- 长会话会填满 Context Window，需要自动压缩（第 13 章）

## 前后呼应

- 本节的 Context Window 限制，是 **[第 13 章](./13-1-Token窗口的上限与长会话问题.md)** 讲自动压缩的根本原因
- 本节的 Token 计数，在 **[13-2 节](./13-2-AutoCompact触发时机.md)** 会看到触发压缩的具体阈值逻辑

## 下一节预告

下一节讲**流式响应**——Claude 是怎么"一边生成一边传送"token 的？SSE 是什么？

➡️ [下一节：5-2 流式响应（Streaming）是怎么工作的](./5-2-流式响应是怎么工作的.md)
