# 16-2 磁盘 Skills 与 Bundled Skills

Skills 来自两个完全不同的来源：磁盘上的 `.md` 文件和代码里硬编码的内置定义。这两种来源最终都变成同一个 `Command` 对象，但中间的路径截然不同。这一节追踪两条路径的完整实现。

---

## 磁盘 Skills：从 Markdown 到 Command 对象

磁盘 Skills 存放在：

```
~/.claude/skills/          ← 用户全局 skills（source: 'userSettings'）
.claude/skills/            ← 项目级 skills（source: 'projectSettings'）
```

每个 skill 是一个 `.md` 文件，文件名（去掉 `.md` 后缀，斜杠替换路径分隔符）就是 skill 的名字。比如 `.claude/skills/review-pr.md` 的名字就是 `review-pr`。

### Frontmatter 字段解析

[src/skills/loadSkillsDir.ts:184-265](../src/skills/loadSkillsDir.ts#L184-L265) 里的 `parseSkillFrontmatterFields()` 解析 skill 文件的所有 Frontmatter 字段：

```typescript
export function parseSkillFrontmatterFields(
  frontmatter: FrontmatterData,
  markdownContent: string,
  resolvedName: string,
  descriptionFallbackLabel: 'Skill' | 'Custom command' = 'Skill',
): {
  displayName: string | undefined      // 覆盖文件名显示
  description: string                  // 在 skill 列表里显示，也是 Claude 判断何时使用的依据
  hasUserSpecifiedDescription: boolean // description 是显式写的还是从内容推断的
  allowedTools: string[]               // 限制这个 skill 执行时能使用的工具
  argumentHint: string | undefined     // 命令行自动补全的参数提示
  argumentNames: string[]              // 命名参数（用于 $ARGUMENTS 模板替换）
  whenToUse: string | undefined        // 额外的使用时机说明（合并进 description 显示）
  version: string | undefined          // skill 版本号
  model: ReturnType<typeof parseUserSpecifiedModel> | undefined  // 覆盖模型
  disableModelInvocation: boolean      // 禁止通过 SkillTool 调用（必须用户手动调用）
  userInvocable: boolean               // 是否在用户界面可见
  hooks: HooksSettings | undefined     // skill 执行时触发的 hooks
  executionContext: 'fork' | undefined  // 'fork' 或 undefined（内联）
  agent: string | undefined            // fork 模式下使用的 agent 类型
  effort: EffortValue | undefined      // 努力程度设置
  shell: FrontmatterShell | undefined  // shell 命令执行设置
}
```

这些字段里，几个重要的：

**`description` vs `whenToUse`**：两个字段都影响 skill 列表里的展示。实际上在 [src/tools/SkillTool/prompt.ts:43-49](../src/tools/SkillTool/prompt.ts#L43-L49) 里，它们被拼接在一起：

```typescript
function getCommandDescription(cmd: Command): string {
  const desc = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description
  return desc.length > MAX_LISTING_DESC_CHARS
    ? desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + '\u2026'
    : desc
}
```

`description` 是简短说明（"做什么"），`whenToUse` 是补充的使用时机（"什么情况下用"）。两者合并后截断到 250 字符（`MAX_LISTING_DESC_CHARS`）。

**`allowedTools`**：当 skill 运行时，这个字段限制 Claude 能使用的工具集。比如 `allowedTools: ["Bash", "Read"]` 意味着 Claude 在执行这个 skill 时只能用 Bash 和 Read 工具，不能调用其他工具。这是一个安全边界。

**`context: fork`**：触发 Fork 执行模式。没有这个字段时默认是内联模式。

**`model: inherit`**：特殊值，意思是不覆盖模型（使用当前对话的模型）：
```typescript
const model =
  frontmatter.model === 'inherit'
    ? undefined
    : frontmatter.model
      ? parseUserSpecifiedModel(frontmatter.model as string)
      : undefined
```

**`user-invocable: false`**：将 skill 设为隐藏（不在 skill 列表里显示给 Claude），但仍然可以被其他机制触发。

### createSkillCommand()：Command 对象的组装

[src/skills/loadSkillsDir.ts:270-400](../src/skills/loadSkillsDir.ts#L270-L400) 里的 `createSkillCommand()` 把解析出的字段组装成 `Command` 对象，最关键的是 `getPromptForCommand()` 方法：

```typescript
async getPromptForCommand(args, toolUseContext) {
  let finalContent = baseDir
    ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
    : markdownContent

  // $ARGUMENTS 等模板变量替换
  finalContent = substituteArguments(finalContent, args, true, argumentNames)

  // Windows 路径处理
  if (baseDir) {
    const skillDir = process.platform === 'win32'
      ? baseDir.replace(/\\/g, '/')
      : baseDir
    finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
  }

  // 会话 ID 替换
  finalContent = finalContent.replace(/\$\{CLAUDE_SESSION_ID\}/g, getSessionId())

  // Shell 命令执行（! 反引号语法）— MCP skills 禁止
  if (loadedFrom !== 'mcp') {
    finalContent = await executeShellCommandsInPrompt(
      finalContent,
      { ...toolUseContext, ... },
      `/${skillName}`,
      shell,
    )
  }

  return [{ type: 'text', text: finalContent }]
},
```

这个方法在 skill 被调用时执行。它做了几件事：
1. 如果有 `baseDir`（skill 的根目录），前置 `Base directory for this skill: <path>` 指示词，让 Claude 知道 skill 的参考文件在哪里
2. 替换模板变量（`$ARGUMENTS`、`${CLAUDE_SKILL_DIR}`、`${CLAUDE_SESSION_ID}`）
3. 执行内嵌的 shell 命令（`!` 语法）并把输出插回内容

---

## 内嵌 Shell 命令（`!` 语法）

这是一个强大但容易被忽视的特性。skill 的 Markdown 内容里可以用 `!` 前缀嵌入 shell 命令：

```markdown
Current branch: !`git branch --show-current`

Recent commits:
!```
git log --oneline -10
```!
```

当 skill 被调用时，这些 shell 命令会被实际执行，输出替换进 skill 内容。这意味着 skill 可以携带**动态的运行时信息**，而不只是静态文本。

安全限制：MCP 来源的 skills **禁止**执行内嵌 shell 命令（`if (loadedFrom !== 'mcp')`）。因为 MCP skills 来自外部服务器，是不可信来源，如果允许执行任意 shell 命令，就是一个严重的安全漏洞。本地磁盘的 skills 来自用户自己或项目配置，相对可信。

---

## Bundled Skills：内置 Skills 的注册机制

Bundled Skills 是编译进 CLI 二进制文件的内置 skills，不来自磁盘，而是通过代码注册。

[src/skills/bundledSkills.ts:14-41](../src/skills/bundledSkills.ts#L14-L41) 里的 `BundledSkillDefinition` 类型：

```typescript
export type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation?: boolean  // true → 禁止 SkillTool 调用，用户必须手动 /cmd
  userInvocable?: boolean
  isEnabled?: () => boolean         // 动态启用/禁用判断
  hooks?: HooksSettings
  context?: 'inline' | 'fork'
  agent?: string
  files?: Record<string, string>    // 随 skill 一起提取到磁盘的参考文件
  getPromptForCommand: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}
```

注册一个 bundled skill：

```typescript
// 在某个初始化模块里
registerBundledSkill({
  name: 'commit',
  description: 'Create a git commit with conventional commit format',
  whenToUse: 'When user wants to commit staged changes',
  allowedTools: ['Bash', 'Read'],
  async getPromptForCommand(args, context) {
    return [{ type: 'text', text: `
# Commit Task
1. Run git status to see what's staged
2. Run git diff --staged to review changes
3. Generate a commit message following conventional commits format
4. Execute git commit
...
    `}]
  }
})
```

[src/skills/bundledSkills.ts:53-100](../src/skills/bundledSkills.ts#L53-L100) 里 `registerBundledSkill()` 的实现展示了一个细节——当 skill 有 `files` 字段时：

```typescript
if (files && Object.keys(files).length > 0) {
  skillRoot = getBundledSkillExtractDir(definition.name)
  // 懒加载：第一次调用时才提取文件到磁盘
  // 使用 Promise 而不是 boolean，防止并发竞争
  let extractionPromise: Promise<string | null> | undefined
  const inner = definition.getPromptForCommand
  getPromptForCommand = async (args, ctx) => {
    extractionPromise ??= extractBundledSkillFiles(definition.name, files)
    const extractedDir = await extractionPromise
    const blocks = await inner(args, ctx)
    if (extractedDir === null) return blocks
    return prependBaseDir(blocks, extractedDir)
  }
}
```

`files` 字段允许 bundled skill 携带参考文件（比如代码模板、配置示例）。这些文件在 skill 第一次被调用时才提取到磁盘，之后复用已提取的版本（`extractionPromise` 缓存 Promise，不是结果，防止并发重复写入）。

提取到磁盘的目录路径是 `getBundledSkillExtractDir(skillName)`，用了一个进程级别的随机 nonce 作为目录名的一部分，防止路径预测攻击。

---

## 安全的文件写入：O_NOFOLLOW | O_EXCL

[src/skills/bundledSkills.ts:176-192](../src/skills/bundledSkills.ts#L176-L192) 里 `safeWriteFile()` 的实现有很好的安全注释：

```typescript
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
const SAFE_WRITE_FLAGS =
  process.platform === 'win32'
    ? 'wx'
    : fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      O_NOFOLLOW

async function safeWriteFile(p: string, content: string): Promise<void> {
  const fh = await open(p, SAFE_WRITE_FLAGS, 0o600)
  try {
    await fh.writeFile(content, 'utf8')
  } finally {
    await fh.close()
  }
}
```

`O_EXCL`：文件必须不存在才能创建（防止覆盖已存在的文件）。  
`O_NOFOLLOW`：如果最终路径是符号链接，拒绝创建（防止 symlink 攻击）。  
`0o600`：只有文件所有者可读写。

注释解释了这些标志的组合原因：`The per-process nonce in getBundledSkillsRoot() is the primary defense against pre-created symlinks/dirs. O_NOFOLLOW|O_EXCL is belt-and-suspenders.` 随机 nonce 路径是主要防线，文件标志是双重保险。

---

## getSkillsPath()：各来源的路径映射

[src/skills/loadSkillsDir.ts:77-93](../src/skills/loadSkillsDir.ts#L77-L93)：

```typescript
export function getSkillsPath(
  source: SettingSource | 'plugin',
  dir: 'skills' | 'commands',
): string {
  switch (source) {
    case 'policySettings':
      return join(getManagedFilePath(), '.claude', dir)
    case 'userSettings':
      return join(getClaudeConfigHomeDir(), dir)    // ~/.claude/skills/
    case 'projectSettings':
      return `.claude/${dir}`                        // .claude/skills/
    case 'plugin':
      return 'plugin'
    default:
      return ''
  }
}
```

`dir` 参数支持 `'skills'` 和 `'commands'`——后者是旧路径（`.claude/commands/`），现在被标记为 `commands_DEPRECATED`，仍然支持但不推荐。

---

## 路径冲突与去重

如果用户有多个加载路径（项目级 + 用户级 + 插件），可能加载出重名 skill 或者同一个文件被多个路径加载（比如通过 `--add-dir` 指定的额外目录和默认目录重叠）。

[src/skills/loadSkillsDir.ts:117-123](../src/skills/loadSkillsDir.ts#L117-L123) 里用 `realpath()` 解析真实路径来做去重：

```typescript
async function getFileIdentity(filePath: string): Promise<string | null> {
  try {
    return await realpath(filePath)  // 解析所有符号链接到真实路径
  } catch {
    return null
  }
}
```

注释说明了为什么用 `realpath` 而不是 inode：`Uses realpath to resolve symlinks, which is filesystem-agnostic and avoids issues with filesystems that report unreliable inode values (e.g., inode 0 on some virtual/container/NFS filesystems, or precision loss on ExFAT).`

---

## 优先级规则：同名 skill 谁赢

当项目级和用户级都有同名 skill 时，项目级优先（和 CLAUDE.md 的规则一致）。具体实现是加载顺序和去重逻辑的结合：

```
加载顺序：policy > project > user > plugin > bundled

同名 skill：先加载的赢（project 先于 user 加载，所以 project 优先）
```

这个优先级确保了：你可以在用户级定义一个 commit skill，但如果某个项目有特殊的 commit 规范，可以在项目级覆盖它。

---

## estimateSkillFrontmatterTokens()：Token 预算估算

[src/skills/loadSkillsDir.ts:99-104](../src/skills/loadSkillsDir.ts#L99-L104)：

```typescript
export function estimateSkillFrontmatterTokens(skill: Command): number {
  const frontmatterText = [skill.name, skill.description, skill.whenToUse]
    .filter(Boolean)
    .join(' ')
  return roughTokenCountEstimation(frontmatterText)
}
```

在构建 SkillTool 的提示词时（下一章详解），需要估算所有 skill 描述占用多少 token，以便在超出预算时做截断。注意：这里只估算 frontmatter 的 token 数（名字 + 描述 + 使用时机），因为 skill 的完整内容只在被调用时才加载，不在 System Prompt 里。

---

## Command 对象的完整结构

无论是磁盘 skill 还是 bundled skill，最终都变成同一个 `Command` 类型（具体来说是 `PromptCommand` 子类型）。关键字段包括：

```typescript
type PromptCommand = {
  type: 'prompt'
  name: string                      // skill 的唯一标识符
  description: string
  source: 'project' | 'user' | 'plugin' | 'bundled'
  loadedFrom: LoadedFrom
  allowedTools: string[]
  context: 'inline' | 'fork' | undefined
  model: string | undefined
  disableModelInvocation: boolean
  userInvocable: boolean
  isHidden: boolean                 // !userInvocable
  progressMessage: string           // 执行时显示的进度文本
  contentLength: number             // markdown 内容长度（估算 token 用）
  getPromptForCommand: (args, context) => Promise<ContentBlockParam[]>
  // ...
}
```

`getPromptForCommand` 是这个对象最重要的方法——它在 skill 被调用时动态生成最终的提示词内容（包括模板替换、shell 命令执行等）。

---

## 本章小结

磁盘 Skills vs Bundled Skills 的核心区别：
- **磁盘 Skills**：运行时从 `.claude/skills/*.md` 加载，通过 Frontmatter 配置行为
- **Bundled Skills**：编译进二进制，通过 `registerBundledSkill()` 在启动时注册，可以携带 `files` 参考文件

两者最终都变成 `Command` 对象，共享同一个 `getPromptForCommand()` 接口。

重要的 Frontmatter 字段：`description`（决定 Claude 何时使用）、`allowedTools`（执行时的工具限制）、`context: fork`（独立子 Agent 执行）。

安全细节：内嵌 shell 命令（`!` 语法）对 MCP skills 禁用，bundled skill 文件提取用 O_NOFOLLOW|O_EXCL 防御符号链接攻击。

## 前后引用

- skill 被 Claude 调用后的完整执行链路，在 **[16-3 节](./16-3-SkillTool执行流程.md)** 追踪
- skill 的名字和描述如何出现在 System Prompt 里，在 **[16-4 节](./16-4-Skills和SystemPrompt的关系.md)** 详解

## 下一节预告

下一节追踪 SkillTool 被 Claude 调用后发生的完整过程：权限检查、内联 vs fork 路由决策、skill 内容如何变成对话消息，以及 `contextModifier` 如何临时调整可用工具集。

➡️ [下一节：16-3 SkillTool：Skills 如何被 Claude 调用](./16-3-SkillTool执行流程.md)
