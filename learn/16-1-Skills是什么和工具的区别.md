# 16-1 Skills 是什么？和"工具"有什么本质区别

在理解 Claude Code 的架构时，Skills（技能/斜杠命令）是最容易被误解的概念之一。很多人看到 `/commit`、`/review-pr` 这样的命令，觉得它们是"Claude 能用的工具"。但其实 Skills 和 Tools 有着根本性的区别——理解这个区别，是读懂 SkillTool 实现的关键。

---

## 工具（Tool）的本质：代码执行

工具的工作方式是：Claude 调用 → 代码运行 → 结果返回给 Claude。

```
Claude: "我要用 BashTool"
  → { "command": "git log --oneline -5" }
        ↓
    BashTool.call() 执行
        ↓
    shell 实际运行 git log
        ↓
    stdout 返回给 Claude
        ↓
Claude: "最近 5 条提交是..."
```

工具是 Claude 与外部世界交互的接口。工具产生**真实的副作用**：文件被写入、命令被执行、API 被调用。工具是双向的——Claude 给出输入，工具给回输出，Claude 继续基于这个输出工作。

---

## Skills 的本质：Prompt 注入

Skills 的工作方式完全不同：用户请求 → Claude 调用 SkillTool → **更多提示词被注入对话** → Claude 按照这些提示词工作。

```
用户: "帮我写一个 commit"（或明确调用 /commit）

Claude 决策: 这匹配 'commit' skill，调用 SkillTool
  → { "skill": "commit" }
        ↓
  SkillTool 找到 commit skill 的 Markdown 文件
        ↓
  把 Markdown 文件的内容注入为一条 user message:
  "你现在处于 commit 技能的执行模式。
   请执行以下步骤：
   1. 运行 git status 检查暂存区
   2. 生成规范的 commit message
   3. 执行 git commit
   ..."
        ↓
  Claude 读取这些指令，然后按照指令使用 BashTool 等工具来完成工作
```

Skills 的本质是**给 Claude 的说明书**。Skill 本身不执行任何操作，它只是向 Claude 注入了一段详细的操作指南，然后 Claude 按照这份指南调用真正的工具来完成工作。

---

## 认知类比

用编程中的概念类比：

- **工具（Tool）**就像**函数调用**：你传入参数，函数执行代码，返回结果。
- **Skills（技能）**就像**代码模板展开**：调用 skill 就像调用一个宏（macro），它把一段预定义的指令序列"展开"到当前上下文里，然后 Claude 在这个扩展后的上下文里工作。

或者更直白地说：
- 工具是 Claude 的**手**（做事情）
- Skills 是 Claude 的**说明书**（指导 Claude 怎么做事情）

---

## 为什么要有这个区别？

这个设计解决了一个实际问题：**复杂任务的可重用指令**。

有些任务需要 Claude 完成一系列协调工作，比如"创建一个规范的 git commit"：
1. 运行 `git status`
2. 查看 `git diff --staged`
3. 按项目规范生成 commit message
4. 执行 `git commit -m "..."`

如果没有 Skills，用户每次都要重新描述这个流程。如果把它写进 System Prompt，又会占用大量固定 token，而且不够灵活（不同项目可能有不同的 commit 规范）。

Skills 的解法是：把这段指令存在磁盘上（`.claude/skills/commit.md`），只在用户需要时按需注入。这样：
- 平时不占用 System Prompt 的 token 预算
- 可以在不同项目里定制（项目级 vs 用户级）
- 可以通过自然语言请求触发（Claude 识别出需要调用这个 skill）

---

## SkillTool 是怎么融合进工具体系的

有趣的是，Skills 的执行入口本身**就是一个工具**——`SkillTool`（名字是 `Skill`）。

Claude 调用 SkillTool（像调用其他工具一样），SkillTool 的 `call()` 方法把 skill 的 Markdown 内容转化成对话消息。这是一个设计上的优雅之处：通过工具调用协议统一了两种机制——Skills 不需要特殊的"命令处理"通道，它走的是和 BashTool、FileWriteTool 完全一样的工具调用链路。

[src/tools/SkillTool/prompt.ts:173-196](../src/tools/SkillTool/prompt.ts#L173-L196) 里，SkillTool 给 Claude 的使用说明：

```typescript
export const getPrompt = memoize(async (_cwd: string): Promise<string> => {
  return `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
...
Important:
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
`
})
```

注意最后一条：`If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded`。这是防止 Claude 重复调用 SkillTool 的机制——一旦 skill 内容被注入到对话里（标记为 `<command-name>` tag），Claude 就直接按照内容工作，不需要再次调用 SkillTool。

---

## Skills 的来源

[src/skills/loadSkillsDir.ts:66-73](../src/skills/loadSkillsDir.ts#L66-L73) 定义了 Skills 可以从哪里来：

```typescript
export type LoadedFrom =
  | 'commands_DEPRECATED'  // 旧路径 .claude/commands/（已废弃）
  | 'skills'               // 磁盘 skills 文件（.claude/skills/）
  | 'plugin'               // 插件提供的 skills
  | 'managed'              // 策略管理的 skills
  | 'bundled'              // 内置 skills（代码里注册）
  | 'mcp'                  // MCP 服务器提供的 skills
```

按照优先级从高到低：
1. `managed`（IT 策略管理）
2. `plugin`（插件）
3. `skills`（磁盘：项目级 `.claude/skills/` > 用户级 `~/.claude/skills/`）
4. `bundled`（内置，代码编译进去）
5. `mcp`（MCP 服务器提供）

---

## 用户体验：斜杠命令的双重触发方式

从用户角度，Skills 可以通过两种方式触发：

**方式 1：用户直接输入斜杠命令**

用户在命令行输入 `/commit -m "Fix login bug"`，Claude Code 直接识别这是一个斜杠命令，不经过 Claude 的 AI 判断，直接执行对应的 Skill。

**方式 2：Claude 主动识别并调用**

用户自然语言说 "帮我提交这些改动，用规范的 commit 格式"。Claude 分析后发现这匹配 `commit` skill，主动调用 `SkillTool({ skill: "commit" })`。

两种方式最终都会把 skill 的 Markdown 内容注入到对话，效果是一样的。区别在于方式 1 更确定（用户明确指定），方式 2 更智能（Claude 自动判断）。

---

## 两种执行模式

SkillTool 有两种执行模式，对应两种不同的 skill 类型：

**内联模式（inline）**：Skill 内容作为 user message 注入到当前对话，Claude 在同一个上下文里处理。这是默认模式。适用于相对简单的任务，或者需要访问当前对话上下文的任务。

**Fork 模式（fork）**：Skill 在独立的子 Agent 里执行，子 Agent 有自己的 token 预算，执行完后把结果文本返回给主 Agent。适用于大型、独立的任务（比如"分析整个代码库的架构"），或者需要防止 token 溢出的长任务。

这两种模式的完整实现在 [16-3 节](./16-3-SkillTool执行流程.md) 详解。

---

## 本章小结

Skills vs Tools 的根本区别：
- **Tools**：Claude 调用 → 代码执行 → 结果返回（双向交互）
- **Skills**：Claude 调用 SkillTool → Markdown 内容注入对话 → Claude 按指南工作（单向注入）

Skills 本质是"给 Claude 的可重用说明书"，解决复杂任务指令的复用和按需注入问题。

SkillTool 本身是一个工具，通过标准工具调用协议桥接两种机制。

## 前后引用

- Skills 的磁盘存储格式和内置 Skills 的注册机制，在 **[16-2 节](./16-2-磁盘Skills与BundledSkills.md)** 详解
- SkillTool 的完整执行流程（内联 vs Fork），在 **[16-3 节](./16-3-SkillTool执行流程.md)** 深入

## 下一节预告

下一节深入 Skills 的存储与注册：磁盘上的 `.md` 文件是如何被解析成 `Command` 对象的？内置 Skills 是如何在启动时注册的？Frontmatter 里的每个字段有什么作用？

➡️ [下一节：16-2 磁盘 Skills 与 Bundled Skills](./16-2-磁盘Skills与BundledSkills.md)
