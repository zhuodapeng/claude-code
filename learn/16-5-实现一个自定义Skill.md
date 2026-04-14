# 16-5 实现一个自定义 Skill

前几节讲了 Skills 系统的内部实现。这一节我们把理解转化为实践：从零创建一个真实的自定义 skill，覆盖所有关键的 Frontmatter 字段、内嵌 shell 命令、内联 vs Fork 选择，以及调试技巧。

---

## 场景：一个代码审查 Skill

我们要创建一个 `review-pr` skill，用于在 Claude Code 里对当前 git 差异做代码审查。

这个 skill 需要：
1. 获取当前分支的 PR 差异
2. 关注性能、安全、代码质量
3. 生成结构化的审查报告

---

## 创建 Skill 文件

在项目根目录创建 `.claude/skills/review-pr.md`（项目级，只影响这个项目）：

```markdown
---
description: Code review focused on correctness, security, and performance
when_to_use: When user wants to review code changes, check a PR, or audit recent commits. Also use when user says "review this" or "what do you think about my changes".
allowed-tools: Bash, Read, Grep
argument-hint: [base-branch] (defaults to main)
---

# Code Review Task

Review the code changes in this branch against `$ARGUMENTS` (default: main).

## Current Context

Branch: !`git branch --show-current`
Changed files:
!```bash
git diff --name-only ${ARGUMENTS:-main}...HEAD 2>/dev/null || echo "(not a git repo)"
```!

## Review Instructions

Perform a thorough code review of all changes. Focus on:

1. **Correctness**: Logic errors, edge cases, null pointer risks
2. **Security**: SQL injection, XSS, command injection, credential exposure
3. **Performance**: N+1 queries, unnecessary loops, missing indexes
4. **Code Quality**: Naming clarity, function complexity, test coverage

Use `Bash` to run `git diff ${ARGUMENTS:-main}...HEAD` to see the actual changes.
Use `Read` to examine specific files in depth.
Use `Grep` to find related code patterns.

## Output Format

Structure your review as:

### Summary
(1-2 sentences on overall quality)

### Issues Found
For each issue:
- **[SEVERITY]** File:line — Description
  - Why it matters
  - Suggested fix

### Good Practices Noticed
(Brief notes on well-written parts)

Severity levels: CRITICAL / HIGH / MEDIUM / LOW / SUGGESTION
```

---

## 逐行解析 Frontmatter

### `description`：Claude 用来决策的依据

```yaml
description: Code review focused on correctness, security, and performance
```

这是 skill 在列表里显示的核心描述。Claude 读到用户请求时，会对比请求和所有 skills 的 description/whenToUse，决定是否调用。

**注意**：这里的描述越精准，Claude 的调用判断越准确。"Code review" 这个 description 比 "Review code" 更好，因为它表明了关注点。

### `when_to_use`：触发时机的补充说明

```yaml
when_to_use: When user wants to review code changes, check a PR, or audit recent commits. Also use when user says "review this" or "what do you think about my changes".
```

这个字段的内容会拼接到 description 后面，一起出现在 skill 列表里：
```
- review-pr: Code review focused on correctness, security, and performance - When user wants to review code changes...
```

注意：`when_to_use` 里可以直接列出触发词（"review this"、"what do you think"），这会提高 Claude 的召回率——Claude 把这些词识别为触发条件，更准确地决定何时使用这个 skill。

### `allowed-tools`：执行时的工具限制

```yaml
allowed-tools: Bash, Read, Grep
```

在这个 skill 执行期间，Claude 只能使用这三个工具。这是一个双重作用的字段：
1. **安全约束**：防止 skill 执行中意外调用其他工具（比如 Write 写文件）
2. **权限触发**：有 `allowedTools` 的 skill 不会自动允许，用户需要确认（recall: `skillHasOnlySafeProperties()` 检查）

如果不指定 `allowed-tools`，skill 执行时可用所有工具，也会自动被允许调用（无需权限弹窗）。

### `argument-hint`：命令行自动补全提示

```yaml
argument-hint: [base-branch] (defaults to main)
```

这个字段出现在命令补全提示里，告诉用户这个 skill 接受什么参数。当用户输入 `/review-pr` 然后看到参数补全，会显示 `[base-branch] (defaults to main)`。

### `$ARGUMENTS` 模板变量

在 Markdown 内容里，`$ARGUMENTS` 会被替换为用户调用时提供的参数字符串。比如：

- 用户调用 `/review-pr dev` → `$ARGUMENTS` = `"dev"`
- 用户调用 `/review-pr` → `$ARGUMENTS` = `""`（空字符串）

在我们的例子里：
```bash
git diff ${ARGUMENTS:-main}...HEAD  # 如果 ARGUMENTS 为空，用 main 作为默认
```

这个 `${ARGUMENTS:-main}` 是 shell 的默认值语法（在 shell 命令执行时生效），不是 `substituteArguments()` 的功能。

---

## 内嵌 Shell 命令（`!` 语法）

我们的 skill 里用了两处内嵌 shell：

**单行格式**：
```
Branch: !`git branch --show-current`
```
执行后变成：
```
Branch: feature/improve-auth
```

**多行格式**：
```
!```bash
git diff --name-only ${ARGUMENTS:-main}...HEAD 2>/dev/null || echo "(not a git repo)"
```!
```
注意两端的 `` !``` `` 和 `` ```! `` 标记。执行后变成实际的 git 输出。

内嵌 shell 命令让 skill 携带**动态的运行时信息**。Claude 看到的 skill 内容已经包含了当前分支名和改动文件列表——它不需要自己先调用 Bash 获取这些信息，可以直接进入审查工作。

**执行环境**：`executeShellCommandsInPrompt()` 使用 `allowedTools` 里配置的工具执行权限运行 shell 命令，所以 `allowed-tools: Bash` 也保证了内嵌 shell 能执行。

**安全限制提醒**：MCP skills 禁止内嵌 shell（来自不可信来源）；项目级 `.claude/skills/` 的 skill 来自仓库，由你和你的团队控制，相对可信。

---

## 内联 vs Fork：如何选择

默认情况下（没有 `context: fork`），这个 skill 用内联模式执行。

**选内联（默认）**：
- skill 需要访问当前对话的历史（比如"审查我们刚才讨论的那部分代码"）
- skill 执行结果需要和主对话无缝衔接
- skill 相对简短，不会消耗大量 token

**选 Fork（加 `context: fork`）**：
- skill 是独立的大型任务（"分析整个代码库的安全漏洞"）
- skill 执行可能产生大量中间消息，不希望污染主对话
- 你想要隔离的 token 预算（fork 子 Agent 有自己的上下文窗口）

对于我们的 `review-pr` skill，内联模式更合适——审查完成后，用户可能想在同一个对话里追问问题（"第 3 个 issue 具体怎么修？"），内联模式保留了这个上下文连续性。

如果是一个"审查整个代码库"的 skill，可能更适合 fork：
```yaml
context: fork
```

---

## 添加命名参数

如果想要多个命名参数（而不是单一的 `$ARGUMENTS`），可以用 `arguments` 字段：

```yaml
---
arguments:
  - base_branch
  - depth
description: Review code against base branch with configurable depth
---

Review against `$base_branch` (default: main) with depth `$depth` (default: normal).

Instructions: ...
```

然后用户调用 `/review-pr --base_branch=dev --depth=thorough`，`$base_branch` 会被替换为 `dev`，`$depth` 替换为 `thorough`。

这个功能由 `parseArgumentNames()` 和 `substituteArguments()` 在 `createSkillCommand()` 里实现，支持 `$name` 或 `${name}` 两种格式。

---

## 模型覆盖

如果你的 skill 需要一个特别强大（或特别快）的模型：

```yaml
model: claude-opus-4-6    # 使用最强模型
# 或
model: claude-haiku-4-5   # 使用最快模型
# 或
model: inherit            # 使用当前对话的模型（不覆盖）
```

这对于"深度分析"类 skill（需要 Opus）或"快速检查"类 skill（用 Haiku 足够）很有用。

---

## 用户级 vs 项目级

**项目级**（`.claude/skills/review-pr.md`）：
- 只影响这个项目
- 可以提交到 git，团队共享
- 适合项目特定的工作流（比如"按我们公司的 code review checklist 审查"）

**用户级**（`~/.claude/skills/review-pr.md`）：
- 在你所有项目里都可用
- 是你的个人工作流
- 适合通用的偏好（比如"我审查代码时需要特别关注性能"）

如果项目级和用户级有同名 skill，**项目级优先**。

---

## 测试和调试 Skill

**测试 1：确认 skill 被发现**

在 Claude Code 里运行：
```
/debug
```
或者直接问 Claude：
```
你现在有哪些可用的 skills？
```

Claude 会列出所有可用 skills，你应该能看到 `review-pr`。

**测试 2：确认 frontmatter 被正确解析**

如果 skill 没出现在列表里，可能是 YAML 语法错误。在 Claude Code 的终端里：
```bash
CLAUDE_DEBUG=1 claude  # 启用调试日志
```

然后观察 skill 加载时是否有错误。

**测试 3：直接触发 skill**

```
/review-pr                    # 用默认 base (main)
/review-pr dev                # 指定 base 分支
```

**测试 4：验证内嵌 shell 执行**

在 skill 的 Markdown 里加一个调试行：
```
Skill loaded at: !`date`
```

如果 skill 被正确加载，Claude 收到的内容里会包含实际的时间戳，而不是这个 shell 命令字符串。

---

## 完整的 Frontmatter 字段参考

| 字段 | 说明 | 示例 |
|------|------|------|
| `description` | 列表展示描述（Claude 决策依据）| `"Code review..."` |
| `when_to_use` | 触发时机补充 | `"Use when user says review..."` |
| `allowed-tools` | 执行时可用工具 | `"Bash, Read, Grep"` |
| `argument-hint` | 参数补全提示 | `"[branch-name]"` |
| `arguments` | 命名参数列表 | `["base_branch", "depth"]` |
| `model` | 覆盖模型 | `"claude-opus-4-6"` 或 `"inherit"` |
| `context` | 执行模式 | `"fork"` 或不填（内联）|
| `user-invocable` | 是否在列表可见 | `"false"` 隐藏 |
| `disable-model-invocation` | 禁止 Claude 主动调用 | `"true"` 只允许用户手动 |
| `hooks` | 执行时触发的 hook | 见 hooks 文档 |
| `effort` | 努力程度 | `"low"` / `"high"` / 整数 |
| `version` | skill 版本号 | `"1.0.0"` |

---

## 本章小结

创建自定义 Skill 的关键要点：
1. 文件位置：`.claude/skills/<name>.md`（项目级）或 `~/.claude/skills/<name>.md`（用户级）
2. 核心 Frontmatter：`description`（影响 Claude 的调用决策）、`allowed-tools`（安全边界）、`when_to_use`（提高触发精准度）
3. 内嵌 shell：`` !`cmd` `` 或 `` !```bash ... ```! ``，运行时替换为实际输出
4. `$ARGUMENTS` 接收用户参数，`${CLAUDE_SKILL_DIR}` 指向 skill 的目录，`${CLAUDE_SESSION_ID}` 是会话 ID
5. 内联（默认）适合需要上下文连续性的任务；Fork 适合大型、独立的任务

---

## 第 16 章总结

Skills 系统的完整图景：

```
用户/Claude 决定调用一个 skill
    │
    ├── 磁盘 skill (.claude/skills/*.md)
    │       │
    │       └── parseFrontmatter → parseSkillFrontmatterFields → createSkillCommand
    │               │
    │               └── getPromptForCommand：模板替换 + shell 执行
    │
    ├── Bundled skill（代码注册）
    │       │
    │       └── registerBundledSkill → files 懒提取（O_NOFOLLOW|O_EXCL）
    │
    └── MCP skill（来自 MCP 服务器，禁止 shell 执行）

SkillTool.call() 路由
    │
    ├── context: 'fork' → executeForkedSkill → runAgent → extractResultText
    │
    └── 默认内联 → processPromptSlashCommand → newMessages 注入对话
                        └── contextModifier 临时修改工具集/模型
```

## 前后引用

- 完整的 Skills 架构分析从 **[16-1 节](./16-1-Skills是什么和工具的区别.md)** 开始
- 下一部分讲 MCP 和插件系统——MCP skills 是 Skills 和 MCP 两个系统的交叉点，在 **[17-1 节](./17-1-MCP协议是什么.md)** 详解

## 下一章预告

第 17 章深入 MCP（Model Context Protocol）、插件系统和远程会话。MCP 是什么？Claude Code 如何连接外部 MCP 服务器？插件如何扩展 Claude Code 的能力？

➡️ [下一章：17-1 MCP 协议是什么：AI 工具的标准化接口](./17-1-MCP协议是什么.md)
