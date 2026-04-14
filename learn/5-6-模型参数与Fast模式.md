# 5-6 模型参数：temperature、max_tokens、Fast 模式

> **本节目标**：理解 API 调用里的关键参数——`temperature`（创造性）、`max_tokens`（输出上限）、`thinking`（推理模式）以及 Claude Code 特有的 Fast 模式是什么。这些参数直接影响 Claude 的行为和你的 API 费用。

---

## `max_tokens`：输出的上限

`max_tokens` 告诉 API：**Claude 最多可以输出多少 token**。

```typescript
client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 8192,   // 最多输出 8192 个 token
  messages: [...],
})
```

注意几个关键点：

**这是上限，不是目标**。设了 `max_tokens: 8192`，Claude 并不会"努力写够 8192 个 token"——它会在内容写完时自然结束，即使只用了 100 个 token。

**超出上限时，Claude 会被截断**。如果 Claude 的回复超过 `max_tokens`，它会在这里停下，`stop_reason` 变成 `max_tokens`（而不是 `end_turn`）。被截断的回复可能在句子中间停止。

**`max_tokens` 影响费用**。输出 token 比输入 token 贵约 5 倍，所以设置合理的 `max_tokens` 很重要。

**Claude Code 的 max_tokens 是多少？**

**文件：[src/utils/context.ts](../src/utils/context.ts)**

```typescript
export const CAPPED_DEFAULT_MAX_TOKENS = 32000

export function getModelMaxOutputTokens(model: string): number {
  // 不同模型支持不同的最大输出 token
  // Claude Sonnet 4.6 支持最大 64K 输出
  // 但 Claude Code 默认限制在 32K，避免意外消耗过多 token
}
```

Claude Code 默认 `max_tokens` 是 32000，比模型最大值低，是有意保留余量的设计。

---

## `temperature`：随机性/创造性控制

`temperature` 控制 Claude 输出的随机性，范围 0-1：

```
temperature = 0.0  → 几乎确定性输出，每次同样的输入得到几乎同样的输出
temperature = 0.5  → 中等随机，平衡创造性和一致性
temperature = 1.0  → 高度随机，创造性强，但可能更"天马行空"
```

**技术原理**（简化）：

LLM 在每次选择下一个 token 时，会给所有可能的 token 打分（概率）。`temperature` 是一个"温度"参数，调整这个概率分布的"尖锐程度"：

```
temperature = 0：概率分布极度尖锐，几乎总选最高概率的 token
                  → 确定性输出

temperature = 1：概率分布较平滑，按概率随机采样
                  → 多样性输出
```

**Claude Code 使用什么 temperature？**

**注意**：Claude Code 的 API 调用**不设置 `temperature`**——让它使用 API 默认值（约 1.0）。

为什么？因为 Claude Code 的任务是**代码工作**，需要精确性，但 temperature = 0 会让 Claude 的回复变得机械重复，失去自然感。默认 temperature 在实践中效果最好。

---

## `thinking`（Extended Thinking）：让 Claude 先想再说

Claude 3.7+ 支持 **Extended Thinking**：在给出回答前，先有一个"内部思考过程"。

```typescript
client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 8192,
  thinking: {
    type: 'enabled',
    budget_tokens: 10000,   // 允许 thinking 使用的最大 token 数
  },
  messages: [...],
})
```

使用 thinking 时，回复会包含 `thinking` 类型的内容块（用户可以看到 Claude 的推理过程）：

```json
{
  "content": [
    {
      "type": "thinking",
      "thinking": "让我分析一下这个问题...\n首先，我需要考虑...\n然后..."
    },
    {
      "type": "text",
      "text": "（Claude 的最终回答）"
    }
  ]
}
```

**思考过程也消耗 token**，所以 `budget_tokens` 控制 thinking 最多用多少 token。

**Claude Code 里的 thinking 配置**：

在 Claude Code 里，thinking 模式是可选的（通过 `--thinking` 参数或设置开启）。默认关闭，因为：
1. 增加费用（更多 token）
2. 增加延迟（先思考再回答）
3. 大多数普通任务不需要深度推理

对于复杂的调试、架构分析任务，开启 thinking 能显著提升回答质量。

---

## Fast 模式：什么是 Fast Mode？

这是 Claude Code 特有的概念，不是 API 本身的特性。

**Fast 模式** 使用 **Claude Opus 4.6** 的"快速输出"能力，在相同模型下通过优化提供更快的响应速度。

注意：**Fast 模式不是切换到更便宜/弱的模型**，而是同一个 Opus 4.6 模型的不同服务配置，优先响应速度。

**Claude Code 的 Fast 模式实现**：

**文件：[src/utils/fastMode.ts](../src/utils/fastMode.ts#L38-L43)**

```typescript
export function isFastModeEnabled(): boolean {
  // 检查功能开关是否启用
}

export function isFastModeAvailable(): boolean {
  if (!isFastModeEnabled()) {
    return false
  }
  // 检查当前账户是否有权限使用 Fast 模式
  // 需要特定的订阅类型
}
```

**开启 Fast 模式**：
```bash
claude-haha --fast      # 命令行参数
# 或在 TUI 里用 /fast 命令切换
```

---

## 模型选择：Claude Code 用哪个模型？

**文件：[src/utils/model/model.ts](../src/utils/model/model.ts)**

Claude Code 不是只用一个模型，而是根据任务选择：

```typescript
// 主要对话模型（默认）
export function getDefaultSonnetModel(): string {
  return 'claude-sonnet-4-6'
}

// Opus 模型（Fast 模式用）
export function getDefaultOpusModel(): string {
  return 'claude-opus-4-6'
}

// 小型快速模型（内部任务：分析危险命令、生成摘要等）
export function getSmallFastModel(): string {
  return 'claude-haiku-4-5-20251001'
}
```

- **主对话**（用户问题）→ Sonnet 4.6（平衡质量和速度）
- **Fast 模式**→ Opus 4.6（更强，更快）
- **内部任务**（权限判断、压缩摘要等）→ Haiku（便宜快速）

---

## 参数总结表

| 参数 | 作用 | Claude Code 的设置 | 影响 |
|------|------|-------------------|------|
| `model` | 使用哪个模型 | Sonnet 4.6（默认）| 质量和费用 |
| `max_tokens` | 最多输出多少 token | 32000 | 费用上限 |
| `temperature` | 输出随机性 | API 默认（~1.0）| 回复多样性 |
| `thinking` | 是否开启推理 | 默认关闭 | 质量 vs 费用 |
| `stream` | 是否流式响应 | 总是 true | 用户体验 |

---

## 本节小结

- `max_tokens` 是输出上限，不是目标，超出会被截断，Claude Code 默认 32000
- `temperature` 控制随机性（0=确定，1=随机），Claude Code 使用 API 默认值
- Extended Thinking（`thinking`）让 Claude 先推理再回答，提升质量但增加费用和延迟
- Fast 模式不是切换模型，而是同一模型的快速服务配置
- Claude Code 根据任务使用不同模型：Sonnet（主对话）、Opus（Fast 模式）、Haiku（内部任务）

## 前后呼应

- 本节的 `thinking` 模式，在 **[9-3 节](./9-3-流式响应解析逐事件处理.md)** 会看到 `thinking_delta` 事件的处理
- 本节的模型选择，在 **[6-4 节](./6-4-初始化序列20步启动编排.md)** 会看到启动时如何确定使用哪个模型

## 下一节预告

第 5 章结束！四章前置知识全部完成。接下来进入真正的项目源码学习：**第 6 章，启动链路**——从你输入 `claude-haha` 到 TUI 出现，中间经历了什么？

➡️ [下一节：6-1 入口脚本：bin/claude-haha 做了什么](./6-1-入口脚本bin-claude-haha做了什么.md)
