# 16-4 Skills 和 System Prompt 的关系

Claude 需要知道有哪些 skills 可用，才能在用户请求时主动调用它们。但 skills 的完整内容可能非常大（几十 KB），把所有 skills 的全部内容都塞进 System Prompt 是不现实的。这一节解释 skills 是如何以轻量方式出现在 Claude 的上下文里的。

---

## Skills 不在 System Prompt 里，在 system-reminder 里

首先要纠正一个常见误解：skills 的列表**不在**每次 API 调用的 System Prompt 里，而是在每次请求的用户消息队列里以 `<system-reminder>` 形式出现。

具体来说，每次用户发送消息时，Claude Code 会在消息前面注入一段：

```xml
<system-reminder>
The following skills are available for use with the Skill tool:

- commit: Create a git commit with conventional commit format - Use when user wants to commit staged changes
- review-pr: Code review focused on correctness and style
- pdf: Convert document to PDF format - Use when user mentions PDF or document export
...
</system-reminder>
```

这个内容注入的位置是 user 角色的第一条消息之前（在 userContext 里），而不是 system 角色里。这个区别很重要——system prompt 是每次 API 调用都会发送的固定前缀，而 user context 消息虽然也是固定的，但它的内容可以在会话中动态更新（比如新安装了一个 skill）。

---

## 1% Token 预算：SKILL_BUDGET_CONTEXT_PERCENT

[src/tools/SkillTool/prompt.ts:21-24](../src/tools/SkillTool/prompt.ts#L21-L24)：

```typescript
// Skill listing gets 1% of the context window (in characters)
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000  // 1% of 200k tokens × 4 chars/token
```

skill 列表的总字符数被限制在**上下文窗口的 1%**。对于 200k token 的上下文窗口，这等于 `200,000 × 4 × 0.01 = 8,000` 字符（约 2,000 token）。

为什么是 1%？这是一个工程上的判断：足够让 Claude 了解所有 skills 的用途（每个 skill 的名字 + 简短描述），但不超出一个合理的"目录"大小。Skills 的完整内容不需要出现在这里，只在被调用时才加载。

---

## formatCommandsWithinBudget()：预算分配算法

[src/tools/SkillTool/prompt.ts:70-171](../src/tools/SkillTool/prompt.ts#L70-L171) 里的 `formatCommandsWithinBudget()` 实现了一个精巧的预算分配算法：

```typescript
export function formatCommandsWithinBudget(
  commands: Command[],
  contextWindowTokens?: number,
): string {
  const budget = getCharBudget(contextWindowTokens)

  // 第一步：尝试全量展示
  const fullEntries = commands.map(cmd => ({ cmd, full: formatCommandDescription(cmd) }))
  const fullTotal = fullEntries.reduce((sum, e) => sum + stringWidth(e.full), 0) + (fullEntries.length - 1)

  if (fullTotal <= budget) {
    return fullEntries.map(e => e.full).join('\n')  // 全部放得下，直接返回
  }

  // 第二步：放不下时，分离 bundled skills 和其他
  const bundledIndices = new Set<number>()
  const restCommands: Command[] = []
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!
    if (cmd.type === 'prompt' && cmd.source === 'bundled') {
      bundledIndices.add(i)
    } else {
      restCommands.push(cmd)
    }
  }

  // bundled skills 始终保留完整描述，从预算里扣除
  const bundledChars = fullEntries.reduce(
    (sum, e, i) => bundledIndices.has(i) ? sum + stringWidth(e.full) + 1 : sum, 0,
  )
  const remainingBudget = budget - bundledChars

  // 第三步：剩余预算均分给非 bundled skills
  const restNameOverhead = restCommands.reduce(
    (sum, cmd) => sum + stringWidth(cmd.name) + 4, 0,
  ) + (restCommands.length - 1)
  const availableForDescs = remainingBudget - restNameOverhead
  const maxDescLen = Math.floor(availableForDescs / restCommands.length)

  if (maxDescLen < MIN_DESC_LENGTH) {
    // 极端情况：描述完全放不下，非 bundled skills 只显示名字
    return commands.map((cmd, i) =>
      bundledIndices.has(i) ? fullEntries[i]!.full : `- ${cmd.name}`
    ).join('\n')
  }

  // 正常情况：截断非 bundled skills 的描述到 maxDescLen
  return commands.map((cmd, i) => {
    if (bundledIndices.has(i)) return fullEntries[i]!.full
    const description = getCommandDescription(cmd)
    return `- ${cmd.name}: ${truncate(description, maxDescLen)}`
  }).join('\n')
}
```

算法的核心逻辑：

1. **如果全部放得下**：直接输出完整描述
2. **如果放不下**：
   - Bundled skills（内置）始终得到完整描述，从预算里扣除
   - 剩余预算均分给用户自定义/插件 skills
   - 如果均分后每个 skill 的描述空间都不足 20 字符，退化为只显示名字

**为什么 bundled skills 有特殊待遇？**

注释解释：`The listing is for discovery only — the Skill tool loads full content on invoke, so verbose whenToUse strings waste turn-1 cache_creation tokens without improving match rate. Applies to all entries, including bundled, since the cap is generous enough to preserve the core use case.`

Bundled skills 是内置功能的核心（commit、review-pr 等），它们的描述对 Claude 的正确决策至关重要。自定义 skills 描述被截断可能只是轻微影响，但内置 skills 描述不准确会让用户的核心工作流出问题。

---

## MAX_LISTING_DESC_CHARS = 250：单条描述上限

[src/tools/SkillTool/prompt.ts:28-30](../src/tools/SkillTool/prompt.ts#L28-L30)：

```typescript
// Per-entry hard cap.
// The listing is for discovery only — the Skill tool loads full content on invoke,
// so verbose whenToUse strings waste turn-1 cache_creation tokens without
// improving match rate.
export const MAX_LISTING_DESC_CHARS = 250
```

每条 skill 描述（`description + whenToUse`）最多 250 字符。这个限制的理由很清晰：**skill 列表的目的是 discovery（发现），不是完整说明**。Claude 只需要知道"有这个 skill，大概用来做什么"，完整的使用说明在 skill 的 Markdown 内容里，调用时才加载。

冗长的 `whenToUse` 字符串浪费 prompt cache 的"创建开销"——第一次请求需要把这段内容发给 Anthropic 并缓存，但如果内容太长、又对 Claude 的判断没有实质帮助，这个 token 花费是纯浪费。

---

## skills 出现的完整调用链

```
QueryEngine.initSystemPrompt()
    │
    └── assembleToolPool()
            │
            └── SkillTool 被加入工具池
                    │
                    └── SkillTool.prompt = getPrompt()
                            │
                            └── 返回"如何使用 SkillTool"的基本说明

每次 API 调用之前：
    │
    └── buildSystemContextMessages()
            │
            └── 注入 <system-reminder>：
                    │
                    ├── 当前所有 skills 列表（formatCommandsWithinBudget）
                    └── 其他 system-reminder 内容
```

注意：`getPrompt()`（SkillTool 的工具描述）是静态的、会话级别缓存的——它只告诉 Claude "怎么使用 Skill 工具"。而 skills 的**具体列表**是动态的——每次请求可能因为新安装了 skill、或不同的工作目录有不同的 skills，而列表不同。

---

## 为什么 skill 列表用 system-reminder 而不是 System Prompt？

这是一个为了**Prompt Cache 优化**的设计决策。

System Prompt 是 Prompt Cache 的关键前缀——每次 API 调用的 system prompt 内容必须完全相同（字节一致），才能命中 Anthropic 的 prompt cache。如果 skills 列表在 System Prompt 里，只要用户安装了新 skill 或删除了旧 skill，整个 cache 就失效了。

System-reminder 注入在 user 消息里，不影响 system prompt 的 cache key。这样，即使 skills 列表有变化，system prompt 部分仍然 cache-hit，只有 user 消息部分需要重新发送和缓存。

---

## Skill 调用后：SkillTool 的 prompt 里为什么要防止重复调用？

[src/tools/SkillTool/prompt.ts:191-195](../src/tools/SkillTool/prompt.ts#L191-L195)：

```typescript
`- If you see a <${COMMAND_NAME_TAG}> tag in the current conversation turn, 
  the skill has ALREADY been loaded - follow the instructions directly 
  instead of calling this tool again`
```

当 skill 内容通过内联模式注入到对话里时，会有一个 `<command-name>some-skill</command-name>` 标签标记这个内容是某个 skill 的展开。这个标签的存在告诉 Claude：这条 skill 已经加载了，不要再调用 SkillTool 了，直接按照内容工作。

如果没有这条规则，Claude 可能在同一轮里反复调用同一个 skill（注入了内容但还没按内容工作，Claude 误判为还没加载，再次调用...死循环）。

---

## 本章小结

Skills 和 System Prompt 的关系：
1. Skills 列表出现在 `<system-reminder>` 里（动态，每次请求），**不在** System Prompt 里（固定，跨请求缓存）
2. 列表只包含 `name + description`（最多 250 字符），全量内容在调用时才加载
3. `SKILL_BUDGET_CONTEXT_PERCENT = 0.01`：skill 列表占 1% 上下文窗口
4. 预算分配算法：Bundled skills 优先保留完整描述，其余按剩余预算均分
5. 预算超限退化策略：`描述截断 → 名字-only`
6. `<command-name>` tag 防止重复调用

核心设计哲学：**skill 列表是目录，不是说明书**。Claude 靠目录选择 skill，靠完整内容执行 skill。

## 前后引用

- skill 完整内容如何被加载（`getPromptForCommand`），在 **[16-2 节](./16-2-磁盘Skills与BundledSkills.md)** 详解
- system-reminder 注入机制在 query loop 里的位置，在 **[9-1 节](./9-1-queryLoop的全局结构.md)** 有全局说明

## 下一节预告

最后一节是实践导向的：给你一个具体的例子，从零创建一个自定义 Skill，包括所有 frontmatter 字段的实际用法、如何使用内嵌 shell 命令、如何选择 inline vs fork、以及如何调试 skill。

➡️ [下一节：16-5 实现一个自定义 Skill](./16-5-实现一个自定义Skill.md)
