# 15-3 记忆注入：如何把记忆加进 System Prompt

记忆文件存在磁盘上只是第一步。真正有价值的是：在每次 Claude 开始工作之前，这些记忆内容要被加载进 Claude 的上下文，让 Claude 从会话第一秒起就知道你的偏好和背景。这一节追踪记忆从磁盘到 System Prompt 的完整链路。

---

## 两条注入路径

记忆进入上下文有两条独立的路径，分别承担不同的职责：

```
磁盘上的记忆文件
        │
        ├── 路径 A：记忆操作指南
        │       │
        │       └── loadMemoryPrompt()
        │               │
        │               └── 告诉 Claude：
        │                   "你有记忆目录，这里是 MEMORY.md 的内容，这是如何写记忆的规则"
        │                   → 注入到 System Prompt 的一段
        │
        └── 路径 B：CLAUDE.md / 项目规则内容
                │
                └── getMemoryFiles() → filterInjectedMemoryFiles()
                        │
                        └── getUserContext() → claudeMd 字段
                            → 注入到每次对话的 user-context 段
```

两条路径的内容是不同的：
- **路径 A** 注入的是"记忆机制的操作说明"（怎么写记忆、MEMORY.md 的当前索引内容）
- **路径 B** 注入的是"从磁盘读取的 CLAUDE.md 等文件内容"（包含记忆目录里的 MEMORY.md）

---

## 路径 A 详解：loadMemoryPrompt()

[src/memdir/memdir.ts:419-507](../src/memdir/memdir.ts#L419-L507) 里的 `loadMemoryPrompt()` 是记忆系统的核心构建函数：

```typescript
export async function loadMemoryPrompt(): Promise<string | null> {
  const autoEnabled = isAutoMemoryEnabled()

  // KAIROS (助手模式) 使用不同的每日日志范式
  if (feature('KAIROS') && autoEnabled && getKairosActive()) {
    return buildAssistantDailyLogPrompt(skipIndex)
  }

  // 团队模式
  if (feature('TEAMMEM') && teamMemPaths!.isTeamMemoryEnabled()) {
    await ensureMemoryDirExists(teamDir)
    return teamMemPrompts!.buildCombinedMemoryPrompt(extraGuidelines, skipIndex)
  }

  // 个人模式（默认）
  if (autoEnabled) {
    const autoDir = getAutoMemPath()
    await ensureMemoryDirExists(autoDir)       // ← 确保目录存在
    return buildMemoryLines(
      'auto memory',
      autoDir,
      extraGuidelines,
      skipIndex,
    ).join('\n')
  }

  return null  // 记忆系统被禁用
}
```

注意 `ensureMemoryDirExists(autoDir)` 这个调用。为什么要在这里创建目录？

```typescript
// src/memdir/memdir.ts:129-147
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  const fs = getFsImplementation()
  try {
    await fs.mkdir(memoryDir)  // recursive: true，一次性创建整条路径
  } catch (e) {
    // EEXIST 已经在 fs.mkdir 内部处理了
    // 真正的错误（EACCES/EPERM）只记录日志，不抛出
    // 写入时的真实权限错误会在 FileWriteTool 里暴露
  }
}
```

注释里说得很清楚：`Harness guarantees the directory exists so the model can write without checking.`

问题是：如果 Claude 要写记忆但目录不存在，它会先调用 BashTool 执行 `mkdir -p ~/.claude/projects/.../memory/`，这浪费了一个对话轮次，而且如果用户没有允许 BashTool 的权限，这个操作还会被拦截。

解决方案是：在每次构建记忆提示词时，预先创建目录（成本极低，`EEXIST` 被静默忽略）。然后在提示词里明确告诉 Claude：`This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).`

这条 `DIR_EXISTS_GUIDANCE` 字符串是直接硬编码在 `buildMemoryLines()` 里注入到提示词的：

```typescript
// src/memdir/memdir.ts:116-119
export const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'
```

这个设计模式值得记住：**让系统保证前置条件，然后在 prompt 里明确告知这些前置条件已经满足**。不让 Claude 去检查、不让 Claude 去创建，直接告诉它可以干活了。

---

## buildMemoryLines()：构建记忆指南的具体内容

`loadMemoryPrompt()` 最终调用 [src/memdir/memdir.ts:199-266](../src/memdir/memdir.ts#L199-L266) 里的 `buildMemoryLines()`，这个函数组装了 Claude 关于记忆系统的全部操作指南：

```typescript
export function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
  skipIndex = false,
): string[] {
  const lines: string[] = [
    `# ${displayName}`,
    '',
    // 1. 告知记忆目录路径和"目录已存在"保证
    `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
    '',
    // 2. 解释记忆系统的用途
    "You should build up this memory system over time so that future conversations ...",
    '',
    // 3. 注入 4 种类型的完整定义（大段 XML）
    ...TYPES_SECTION_INDIVIDUAL,
    // 4. 注入禁止列表
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    // 5. 两步保存流程
    ...howToSave,
    '',
    // 6. 何时访问记忆
    ...WHEN_TO_ACCESS_SECTION,
    '',
    // 7. 如何信任回忆内容（验证文件/函数是否仍然存在）
    ...TRUSTING_RECALL_SECTION,
    '',
    // 8. 记忆 vs 其他持久化机制的区别（plan、task）
    '## Memory and other forms of persistence',
    ...
  ]

  // 9. 搜索过去上下文的指令（特性门控）
  lines.push(...buildSearchingPastContextSection(memoryDir))
  return lines
}
```

这个函数生成的内容就是你在 Claude Code 的 System Prompt 里看到的 "auto memory" 那一大段。它包含了：
- 完整的 4 种记忆类型定义（每种类型有 when_to_save、how_to_use、examples）
- 两步保存流程（写主题文件 → 更新 MEMORY.md 索引）
- 不应该保存什么的明确规则
- 何时应该访问记忆
- 如何验证从记忆里召回的信息（是否仍然准确）
- 记忆 vs Plan vs Task 的区别（避免把临时任务写进长期记忆）

值得注意的是 `skipIndex` 参数。当 `tengu_moth_copse` 特性门控开启时，`skipIndex = true`，这时"两步保存流程"变成"单步保存"（只写主题文件，不写 MEMORY.md 索引）。这是一个正在实验的架构变化：用 `findRelevantMemories` 的 Sonnet selector 来替代 MEMORY.md 索引作为主要召回机制，如果 Sonnet selector 足够好，可以省去维护索引的开销。

---

## 路径 B 详解：getUserContext() 里的记忆

[src/context.ts:155-189](../src/context.ts#L155-L189) 里的 `getUserContext()` 是第二条注入路径：

```typescript
export const getUserContext = memoize(
  async (): Promise<{[k: string]: string}> => {
    const shouldDisableClaudeMd =
      isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
      (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)

    // getMemoryFiles() 扫描当前目录向上的 CLAUDE.md 和记忆目录
    const claudeMd = shouldDisableClaudeMd
      ? null
      : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
    
    return {
      ...(claudeMd && { claudeMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
    }
  },
)
```

`getMemoryFiles()` 是在 [src/utils/claudemd.ts:790](../src/utils/claudemd.ts#L790) 里定义的大型函数，它扫描：
- 当前目录向上直到 git root 或 home 目录的所有 `CLAUDE.md`、`CLAUDE.local.md`
- `.claude/rules/*.md`
- 记忆目录里的 `MEMORY.md`

然后 `filterInjectedMemoryFiles()` 会过滤掉在 System Prompt 里已经通过路径 A 注入的记忆文件，避免内容重复注入：

```typescript
// src/utils/claudemd.ts:1142-1145
export function filterInjectedMemoryFiles(
  files: MemoryFileInfo[],
): MemoryFileInfo[] {
  // 当 tengu_moth_copse 特性开启时，MEMORY.md 已经通过 attachment 注入，
  // 不应该再出现在 user context 里
  const skipMemoryIndex = getFeatureValue_CACHED_MAY_BE_STALE('tengu_moth_copse', false)
  // ... 根据特性门控过滤
}
```

---

## buildMemoryPrompt()：包含 MEMORY.md 内容的版本

上面的 `buildMemoryLines()` 只包含操作指南，不包含 MEMORY.md 的实际内容（因为实际内容通过路径 B 注入）。但 `buildMemoryPrompt()` 是另一个版本，它包含 MEMORY.md 的当前内容，用于 **Agent 记忆**（子 Agent 的情况，它没有 `getClaudeMds()` 等效物）：

```typescript
// src/memdir/memdir.ts:272-316
export function buildMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
}): string {
  const { displayName, memoryDir, extraGuidelines } = params
  const fs = getFsImplementation()
  const entrypoint = memoryDir + ENTRYPOINT_NAME

  // 同步读取 MEMORY.md（prompt 构建是同步的）
  let entrypointContent = ''
  try {
    entrypointContent = fs.readFileSync(entrypoint, { encoding: 'utf-8' })
  } catch {
    // 文件不存在：首次使用，正常
  }

  const lines = buildMemoryLines(displayName, memoryDir, extraGuidelines)

  if (entrypointContent.trim()) {
    const t = truncateEntrypointContent(entrypointContent)  // 截断到 200 行 / 25KB
    // 记录分析事件：内容大小、是否被截断
    logMemoryDirCounts(memoryDir, { ... })
    lines.push(`## ${ENTRYPOINT_NAME}`, '', t.content)
  } else {
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      '',
      `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
    )
  }

  return lines.join('\n')
}
```

注意这里用的是**同步** `readFileSync`。这是因为 System Prompt 构建是在一个同步上下文里调用的（`systemPromptSection` 缓存机制要求同步返回），所以即使是 I/O，也必须是同步的。这是一个为了适配上层架构约束不得不做的设计选择——注释里的 `// sync: prompt building is synchronous` 就是说明这个原因。

---

## 整体注入流程的时序图

```
session 启动
    │
    ├── QueryEngine.initSystemPrompt()
    │       │
    │       ├── getSystemPrompt()
    │       │       │
    │       │       └── systemPromptSection('memory', loadMemoryPrompt)
    │       │               │
    │       │               └── loadMemoryPrompt()
    │       │                       │
    │       │                       ├── ensureMemoryDirExists()   ← 创建目录
    │       │                       └── buildMemoryLines()         ← 构建操作指南
    │       │                               │
    │       │                               └── 注入到 system prompt
    │       │
    │       └── getUserContext()
    │               │
    │               └── getMemoryFiles() → getClaudeMds()
    │                       │
    │                       └── 包含 MEMORY.md 内容
    │                               │
    │                               └── 注入到每次请求的 user context
    │
    ├── 用户发送第一条消息
    │
    ├── ... query loop 执行 ...
    │
    └── 每轮结束：handleStopHooks()
            │
            └── executeExtractMemories()    ← 后台提取，写新记忆
                    │
                    └── 下次会话时被加载 ↻
```

这个时序揭示了一个重要的延迟：在当前会话里 Claude 学到的内容（通过 `extractMemories`），要到**下一个会话**才能通过 System Prompt 注入生效。当前会话里 Claude 是靠消息历史知道刚才做过什么，不是靠记忆。

---

## KAIROS 模式：助手的记忆策略

`loadMemoryPrompt()` 里有一个特殊分支，`feature('KAIROS')` 是给 Claude.ai 助手模式用的：

```typescript
if (feature('KAIROS') && autoEnabled && getKairosActive()) {
  return buildAssistantDailyLogPrompt(skipIndex)
}
```

助手模式是"永久会话"（persistent session）——一个会话可以持续数天。在这种情况下，维护 MEMORY.md 作为实时索引反而成了问题：每一轮对话都可能写入记忆，频繁更新索引会产生并发写入的问题。

KAIROS 模式的解法是不同的记忆范式：
- **主动写入**：Claude 往 `logs/YYYY/MM/YYYY-MM-DD.md` 追加带时间戳的日志条目（append-only）
- **定期蒸馏**：一个独立的 `/dream` skill 在夜间把日志蒸馏成主题文件 + MEMORY.md 索引

日志文件路径是用模式 `logs/YYYY/MM/YYYY-MM-DD.md` 描述的，而不是当天的实际日期——因为这段提示词是被系统缓存的，如果内联今天的日期，过了午夜缓存就失效了。Claude 自己从 `currentDate` 系统消息里获取今天的日期来计算实际路径。

---

## 为什么记忆操作指南要缓存？

`systemPromptSection('memory', loadMemoryPrompt)` 把 `loadMemoryPrompt()` 的结果缓存起来。System Prompt 是每次 API 调用都要发送的，而且它的前缀需要对 Anthropic 的 prompt cache 保持稳定（字节完全一致）才能命中缓存。

记忆操作指南（4种类型定义、保存步骤、禁止列表）在一次会话里是不变的——即使用户在会话中途写了新记忆，操作指南本身不变。缓存它既节省了重新构建的计算开销，也保证了 prompt cache 的命中率。

MEMORY.md 的内容（通过路径 B 注入）每次新会话开始时才更新。这意味着即使在一次会话里 `extractMemories` 写了新记忆，当前会话的 Claude 看到的 MEMORY.md 索引仍然是会话开始时的版本。

---

## 本章小结

记忆注入有两条独立路径：
1. **路径 A**（操作指南）：`loadMemoryPrompt()` → System Prompt → 告诉 Claude 如何读写记忆
2. **路径 B**（内容）：`getMemoryFiles()` → `getUserContext()` → MEMORY.md 的实际内容

两条路径分离的原因：操作指南在一次会话里不变（适合缓存），内容每次新会话都可能更新（不适合长期缓存）。

`ensureMemoryDirExists()` 在构建提示词时预创建目录，配合提示词里的明确声明，消除 Claude 浪费一轮去 mkdir 的开销。

KAIROS 模式用追加日志 + 夜间蒸馏替代实时维护索引，适配长期运行的助手会话。

## 前后引用

- MEMORY.md 内容的截断策略，在 **[15-4 节](./15-4-记忆的上限与截断策略.md)** 详解
- 写入记忆的后台提取机制，在 **[15-5 节](./15-5-自动记忆提取.md)** 深入

## 下一节预告

下一节讲截断：MEMORY.md 最多 200 行 / 25KB，超出怎么处理？AI 如何在海量记忆文件里找到相关的那几条？记忆过期如何触发警告？

➡️ [下一节：15-4 记忆的上限：截断策略的设计取舍](./15-4-记忆的上限与截断策略.md)
