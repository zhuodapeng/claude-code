# 15-2 MEMORY.md：记忆的存储格式设计

上一节我们理解了为什么需要记忆系统。这一节我们深入到文件系统层面，看记忆到底是怎么存储的：文件放在哪里，格式是什么，为什么是两层结构，以及个人模式和团队模式的区别。

---

## 记忆的存储路径

[src/memdir/paths.ts:223-235](../src/memdir/paths.ts#L223-L235) 里 `getAutoMemPath()` 定义了记忆目录的完整路径：

```typescript
export const getAutoMemPath = memoize(
  (): string => {
    const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
    if (override) {
      return override
    }
    const projectsDir = join(getMemoryBaseDir(), 'projects')
    return (
      join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep
    ).normalize('NFC')
  },
  () => getProjectRoot(),
)
```

默认的路径结构是：

```
~/.claude/
└── projects/
    └── <sanitized-git-root>/    ← 用 git 根目录路径生成的 slug
        └── memory/
            ├── MEMORY.md        ← 索引文件（入口）
            ├── user_role.md     ← 记忆主题文件
            ├── feedback_testing.md
            └── project_auth_rewrite.md
```

这里有几个设计细节值得注意：

**用 git 根目录而不是 CWD 作为 key**：注意路径用的是 `getAutoMemBase()`，它的实现是：
```typescript
function getAutoMemBase(): string {
  return findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()
}
```
这意味着如果你有多个 git worktree（比如 `.claude/worktrees/feature-x/`），它们都会共享同一个 `memory/` 目录，而不是各自独立。同一个代码库的所有 worktree，Claude 对你的了解是共享的。这个决策对应了 worktree 的本质——它们是同一个 git 仓库的不同检出，Claude 对你和项目的了解不应该因为检出方式不同而分裂。

**路径 NFC 规范化**：`.normalize('NFC')` 是针对 macOS 的防御性处理。macOS 文件系统默认用 NFD（Normalization Form D）存储 Unicode 文件名，但 Node.js 的路径操作用 NFC。如果不做规范化，同一个目录路径可能因为 Unicode 格式不同被识别为两个不同的 key，导致记忆分裂。

**memoize 以 projectRoot 为 key**：函数被 lodash memoize 缓存，缓存 key 是 `getProjectRoot()`。这是因为 `getAutoMemPath()` 被渲染路径的代码（比如 `collapseReadSearchGroups → isAutoManagedMemoryFile`）每次渲染 UI 都会调用，如果每次都重新计算（读取 settings.json、filesystem 操作）性能很差。

---

## 两层结构的设计：索引 + 主题文件

记忆系统采用了两层结构：

```
MEMORY.md              ← 第一层：索引，每行一条记录，指向主题文件
user_role.md           ← 第二层：主题文件，每个文件是一条记忆
feedback_testing.md    ← 第二层：主题文件
```

`MEMORY.md` 是什么样的？一个典型的 MEMORY.md 看起来像这样：

```markdown
- [User Role](user_role.md) — senior Go dev, new to this repo's React frontend
- [Testing Policy](feedback_testing.md) — no mocking db; hit real db in integration tests
- [Auth Rewrite Context](project_auth_rewrite.md) — legal compliance, not tech debt
```

每行是一个指针，格式是 `- [标题](文件路径) — 一行摘要`。

[src/memdir/memdir.ts:34](../src/memdir/memdir.ts#L34) 定义了这两个常量：

```typescript
export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
```

**为什么要有这两层结构，而不是把所有记忆都写进 MEMORY.md？**

这是一个容量与可访问性的权衡。MEMORY.md 是**每次对话都会完整加载到 System Prompt 里**的文件（下一节会详细讲这个机制）。如果把所有记忆的全部内容都放在这一个文件里，它会迅速膨胀到几十 KB，每次对话都消耗大量 token，而且很多记忆对当前对话可能是无关的。

两层结构的好处：
- `MEMORY.md` 始终保持轻量（只有索引），每次都加载
- 主题文件只在被判断为相关时才按需加载（通过 `findRelevantMemories`，下一节讲）
- 用户可以阅读 MEMORY.md 快速了解 Claude 记住了什么，不需要翻所有文件

**为什么 MEMORY.md 里每行要有一句摘要？**

注意格式要求：`- [Title](file.md) — one-line hook`，这句 hook 不只是给人看的，它是给 `findRelevantMemories` 里的 Sonnet selector 用的。系统需要在不读取所有主题文件完整内容的情况下，判断哪些记忆和当前对话相关——它只能基于文件名和这一行摘要来做判断。摘要越准确，记忆召回就越精准。

---

## 主题文件的 Frontmatter 格式

主题文件必须有 YAML Frontmatter，[src/memdir/memoryTypes.ts:261-271](../src/memdir/memoryTypes.ts#L261-L271) 定义了标准格式：

```typescript
export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  '```markdown',
  '---',
  'name: {{memory name}}',
  'description: {{one-line description — used to decide relevance in future conversations, so be specific}}',
  `type: {{${MEMORY_TYPES.join(', ')}}}`,
  '---',
  '',
  '{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}',
  '```',
]
```

三个字段：
- `name`：记忆的标题，用于 UI 显示和文件命名参考
- `description`：一行描述，**这个字段极其重要**——它就是 MEMORY.md 里那行 hook 的来源，也是 `scanMemoryFiles()` 读取后用于 AI 召回判断的依据。注释里明确说 "used to decide relevance in future conversations, so be specific"。写 "user preferences" 是没用的，写 "user prefers functional style and explicit type annotations" 才有价值
- `type`：4 种类型之一（user/feedback/project/reference）

**为什么要解析 frontmatter 而不是只用文件名？**

因为文件名会随着内容更新而不准确，而且不同语言的用户命名方式不同。frontmatter 提供了一个结构化的元数据层，不依赖文件命名约定。

[src/memdir/memoryScan.ts:35-77](../src/memdir/memoryScan.ts#L35-L77) 里的 `scanMemoryFiles()` 展示了具体的扫描逻辑：

```typescript
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const mdFiles = entries.filter(
      f => f.endsWith('.md') && basename(f) !== 'MEMORY.md',
    )

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = join(memoryDir, relativePath)
        const { content, mtimeMs } = await readFileInRange(
          filePath,
          0,
          FRONTMATTER_MAX_LINES,   // 只读 30 行！够 frontmatter 了，不读完整内容
          undefined,
          signal,
        )
        const { frontmatter } = parseFrontmatter(content, filePath)
        return {
          filename: relativePath,
          filePath,
          mtimeMs,
          description: frontmatter.description || null,
          type: parseMemoryType(frontmatter.type),
        }
      }),
    )

    return headerResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)   // 按修改时间降序，最新优先
      .slice(0, MAX_MEMORY_FILES)               // 最多 200 个
  } catch {
    return []
  }
}
```

关键设计：`FRONTMATTER_MAX_LINES = 30`，只读前 30 行。因为 frontmatter 通常在文件开头，读 30 行就够提取元数据了，不需要把几十 KB 的记忆文件全部读入内存。这对有很多记忆文件时的性能至关重要。

`recursive: true` 允许记忆文件存放在子目录里（比如 `feedback/`, `project/`），支持用户自己组织记忆的目录结构。

---

## 路径验证：防御性安全设计

[src/memdir/paths.ts:109-150](../src/memdir/paths.ts#L109-L150) 里的 `validateMemoryPath()` 是一个细节但很重要的安全函数：

```typescript
function validateMemoryPath(
  raw: string | undefined,
  expandTilde: boolean,
): string | undefined {
  if (!raw) return undefined
  let candidate = raw
  // ~/foo 展开 home 目录
  if (expandTilde && (candidate.startsWith('~/') || candidate.startsWith('~\\'))) {
    const rest = candidate.slice(2)
    const restNorm = normalize(rest || '.')
    if (restNorm === '.' || restNorm === '..') {
      return undefined  // 拒绝 ~/ 本身或 ~/..，那会指向 $HOME 或上层
    }
    candidate = join(homedir(), rest)
  }
  const normalized = normalize(candidate).replace(/[/\\]+$/, '')
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||              // 拒绝 "/" 或太短路径
    /^[A-Za-z]:$/.test(normalized) ||     // 拒绝 Windows 驱动器根 "C:"
    normalized.startsWith('\\\\') ||       // 拒绝 UNC 网络路径
    normalized.startsWith('//') ||
    normalized.includes('\0')             // 拒绝 null byte（可绕过 syscall）
  ) {
    return undefined
  }
  return (normalized + sep).normalize('NFC')
}
```

注释里解释为什么这么严格：记忆目录路径会被用作**读取许可列表的根目录**。如果一个恶意的 `.claude/settings.json`（提交到 git 里）能把记忆目录设成 `~/.ssh`，那么 Claude Code 的文件系统白名单逻辑就会允许 Claude 向 SSH 密钥目录写文件。

注意 `expandTilde: true` 只用于 settings.json 的路径解析（用户输入），env var 路径永远不展开（它们应该由调用者提供绝对路径）。

还有一个重要细节：只有 `policySettings`、`flagSettings`、`localSettings`、`userSettings` 这几个来源的 `autoMemoryDirectory` 设置才被信任——`projectSettings`（即 `.claude/settings.json` 提交到仓库里的那个）被刻意排除了：

```typescript
function getAutoMemPathSetting(): string | undefined {
  const dir =
    getSettingsForSource('policySettings')?.autoMemoryDirectory ??
    getSettingsForSource('flagSettings')?.autoMemoryDirectory ??
    getSettingsForSource('localSettings')?.autoMemoryDirectory ??
    getSettingsForSource('userSettings')?.autoMemoryDirectory  // 注意：没有 projectSettings！
  return validateMemoryPath(dir, true)
}
```

这是因为 `projectSettings` 是可以被 git 仓库控制的——一个恶意 repo 可以在 `.claude/settings.json` 里设置 `autoMemoryDirectory: "~/.ssh"` 来劫持记忆写入路径。

---

## 个人模式 vs 团队模式

`memoryTypes.ts` 里有两套类型描述：`TYPES_SECTION_INDIVIDUAL`（个人模式）和 `TYPES_SECTION_COMBINED`（团队模式，需要 `feature('TEAMMEM')` 功能门控）。

两者的本质区别是：团队模式下，每种记忆类型有一个 `<scope>` 字段，指明这条记忆应该存在个人目录还是团队共享目录。

```typescript
// 团队模式下，feedback 类型的定义包含 scope 指引：
'    <scope>default to private. Save as team only when the guidance is clearly '
+ 'a project-wide convention that every contributor should follow...'
```

团队模式的目录结构变成：

```
~/.claude/projects/<slug>/memory/          ← 个人记忆目录
~/.claude/projects/<slug>/memory/team/     ← 团队共享记忆目录
```

团队记忆通过一个同步机制（目前是 ant 内部功能 `TEAMMEM` 特性门控）在团队成员之间共享。个人记忆（比如你的沟通偏好）保持私密，项目级记忆（比如测试策略）共享给所有人。

在没有 `TEAMMEM` 功能时（即我们这个开源版本），只有个人记忆目录，所有记忆都是私人的。

---

## 记忆的时效性：memoryAge

[src/memdir/memoryAge.ts](../src/memdir/memoryAge.ts) 处理记忆的时效性问题：

```typescript
// 人类可读的时间：模型不擅长从 ISO 时间戳推算"这条记忆多久了"
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  return `${d} days ago`
}

// 超过 1 天的记忆会附带警告
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ''
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  )
}
```

为什么用 "47 days ago" 而不是 ISO 时间戳？注释里明确说：`Models are poor at date arithmetic — a raw ISO timestamp doesn't trigger staleness reasoning the way "47 days ago" does.` 这是经过观察的结论：给模型一个"2024-11-15T10:23:11.000Z"，它不会自动认为这条记忆可能过期了；给它 "47 days ago"，它会触发"这条可能已经不准确了"的推理。

---

## 本章小结

记忆存储的核心设计：
1. 路径：`~/.claude/projects/<git-root-slug>/memory/`，worktree 共享同一个 memory
2. 两层结构：MEMORY.md（轻量索引）+ 主题文件（按需加载）
3. Frontmatter 格式：name + description（召回依据）+ type（4种分类）
4. description 是最重要的字段，决定了 AI 是否能在未来召回这条记忆
5. 路径验证有严格的安全限制，防止 projectSettings 被恶意利用
6. 超过 1 天的记忆会附带新鲜度警告

## 前后引用

- 记忆如何被注入到 System Prompt，在 **[15-3 节](./15-3-记忆注入System-Prompt.md)** 追踪
- 记忆文件的读取限制和 AI 召回机制，在 **[15-4 节](./15-4-记忆的上限与截断策略.md)** 详解

## 下一节预告

下一节追踪记忆进入 System Prompt 的完整链路：从磁盘文件，到 `getMemoryFiles()`，到 `getUserContext()`，再到 Claude 看到的上下文。

➡️ [下一节：15-3 记忆注入：如何把记忆加进 System Prompt](./15-3-记忆注入System-Prompt.md)
