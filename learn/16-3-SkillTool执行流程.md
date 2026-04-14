# 16-3 SkillTool：Skills 如何被 Claude 调用

当 Claude 决定调用一个 skill 时，`SkillTool` 的 `call()` 方法开始运行。这个过程包括权限检查、路由决策（内联 vs Fork）、内容注入、以及对后续对话的工具集修改。这一节追踪完整流程。

---

## validateInput()：先验证 skill 是否合法

[src/tools/SkillTool/SkillTool.ts:354-430](../src/tools/SkillTool/SkillTool.ts#L354-L430)：

```typescript
async validateInput({ skill }, context): Promise<ValidationResult> {
  const trimmed = skill.trim()
  if (!trimmed) {
    return { result: false, message: `Invalid skill format: ${skill}`, errorCode: 1 }
  }

  // 兼容性：去掉前导斜杠（用户可能输入 /commit）
  const hasLeadingSlash = trimmed.startsWith('/')
  const normalizedCommandName = hasLeadingSlash ? trimmed.substring(1) : trimmed

  // 查找命令（本地 + MCP skills）
  const commands = await getAllCommands(context)
  const foundCommand = findCommand(normalizedCommandName, commands)
  
  if (!foundCommand) {
    return { result: false, message: `Unknown skill: ${normalizedCommandName}`, errorCode: 2 }
  }

  // 禁止通过 SkillTool 调用 disableModelInvocation=true 的 skill
  if (foundCommand.disableModelInvocation) {
    return {
      result: false,
      message: `Skill ${normalizedCommandName} cannot be used with ${SKILL_TOOL_NAME} tool due to disable-model-invocation`,
      errorCode: 4,
    }
  }

  // 必须是 prompt 类型（不是内置命令）
  if (foundCommand.type !== 'prompt') {
    return { result: false, message: `...not a prompt-based skill`, errorCode: 5 }
  }

  return { result: true }
}
```

`disableModelInvocation: true` 的 skill 只能由用户手动触发（比如 `/help`），不能被 Claude 的 AI 判断主动调用。这个开关防止 Claude 主动触发一些设计上只供用户明确调用的命令。

`getAllCommands()` 同时获取本地 skills 和 MCP skills：

```typescript
async function getAllCommands(context: ToolUseContext): Promise<Command[]> {
  // 只包含 loadedFrom === 'mcp' 的 MCP skills，不是普通 MCP prompts
  const mcpSkills = context.getAppState().mcp.commands.filter(
    cmd => cmd.type === 'prompt' && cmd.loadedFrom === 'mcp',
  )
  if (mcpSkills.length === 0) return getCommands(getProjectRoot())
  const localCommands = await getCommands(getProjectRoot())
  return uniqBy([...localCommands, ...mcpSkills], 'name')
}
```

注意这里的过滤条件 `loadedFrom === 'mcp'`——MCP 服务器可以提供两种东西：普通的 MCP prompts 和 MCP skills。只有被明确标记为 skill 的才能通过 SkillTool 调用，防止 Claude 通过 SkillTool 的"猜测"来访问不可发现的 MCP prompts。

---

## checkPermissions()：三层权限决策

[src/tools/SkillTool/SkillTool.ts:432-578](../src/tools/SkillTool/SkillTool.ts#L432-L578)：

```
权限决策流程：
    │
    ├── 1. deny 规则检查（精确匹配 + 前缀通配 `cmd:*`）
    │       有匹配 → 拒绝
    │
    ├── 2. allow 规则检查
    │       有匹配 → 允许
    │
    ├── 3. 安全属性自动允许
    │       skill 没有 hooks / model / allowedTools → 自动允许
    │
    └── 4. 默认：询问用户
            提供两条建议：精确允许 / 前缀通配允许
```

**规则匹配逻辑**：

```typescript
const ruleMatches = (ruleContent: string): boolean => {
  const normalizedRule = ruleContent.startsWith('/') ? ruleContent.substring(1) : ruleContent

  // 精确匹配
  if (normalizedRule === commandName) return true

  // 前缀通配：`review-pr:*` 匹配 `review-pr 123`
  if (normalizedRule.endsWith(':*')) {
    const prefix = normalizedRule.slice(0, -2)  // 去掉 ':*'
    return commandName.startsWith(prefix)
  }
  return false
}
```

前缀通配 `cmd:*` 设计的用意是：允许某个 skill 的所有参数变体。比如 `allow: review-pr:*` 就允许 `review-pr 123`、`review-pr --detailed 456` 等所有带参数的调用。

**安全属性自动允许**（`skillHasOnlySafeProperties()`）：

这是一个白名单机制——如果 skill 满足以下所有条件，自动允许无需用户确认：
- 没有 `hooks`（不触发额外代码）
- 没有 `model` 覆盖（不切换模型）
- 没有 `allowedTools` 限制（不改变工具集）

注释说：`This is an allowlist: if a skill has any property NOT in this set with a meaningful value, it requires permission. This ensures new properties added in the future default to requiring permission.`

这个"默认要求权限"的哲学很重要——任何新增的、可能有安全影响的字段，不需要专门去修改权限检查代码，它们天然就会触发权限询问。

---

## call()：核心路由逻辑

[src/tools/SkillTool/SkillTool.ts:580-800](../src/tools/SkillTool/SkillTool.ts#L580-L800) 里的 `call()` 方法是执行的核心。关键的路由决策：

```typescript
async call({ skill, args }, context, canUseTool, parentMessage, onProgress?) {
  const commandName = skill.trim().startsWith('/') ? skill.trim().substring(1) : skill.trim()
  
  const commands = await getAllCommands(context)
  const command = findCommand(commandName, commands)

  // 记录使用统计（用于排名）
  recordSkillUsage(commandName)

  // 路由决策：fork 还是 inline？
  if (command?.type === 'prompt' && command.context === 'fork') {
    return executeForkedSkill(command, commandName, args, context, canUseTool, parentMessage, onProgress)
  }

  // 内联执行（默认）
  const { processPromptSlashCommand } = await import('src/utils/processUserInput/processSlashCommand.js')
  const processedCommand = await processPromptSlashCommand(
    commandName,
    args || '',
    commands,
    context,
  )
  // ...
}
```

---

## 内联执行路径详解

内联模式下，`processPromptSlashCommand()` 把 skill 内容变成对话消息：

```
processPromptSlashCommand()
    ↓
command.getPromptForCommand(args, context)
    ↓
返回 ContentBlockParam[]（skill 的 Markdown 内容）
    ↓
包装成一条 user message：
{
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'text', text: skill 的 Markdown 内容 }
    ]
  }
}
    ↓
tagMessagesWithToolUseID()：
把这些消息标记为 "来自这个 SkillTool 调用"
（消息会保持临时状态，直到 SkillTool 调用完成）
```

返回给 query loop 的数据结构：

```typescript
return {
  data: {
    success: true,
    commandName,
    allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
    model,
  },
  newMessages,           // ← 这些消息被注入到对话历史
  contextModifier(ctx) {  // ← 修改后续对话的上下文
    if (allowedTools.length > 0) {
      // 临时替换工具集为 skill 指定的工具
    }
    if (model) {
      // 临时切换模型
    }
    return modifiedContext
  },
}
```

`newMessages` 里的内容会被插入到 Claude 的下一次 API 请求中，作为 user 角色的消息。Claude 读到这条消息，发现是详细的操作指南，然后按照指南工作。

**`contextModifier` 的工作机制**：

这是 SkillTool 最有意思的部分之一。当 skill 有 `allowedTools` 时，`contextModifier` 会修改 `ToolUseContext`，临时把可用工具集限制为 skill 指定的工具。这意味着在这个 skill 执行期间，Claude 只能看到 skill 允许的工具，即使全局有更多工具可用。

```typescript
contextModifier(ctx) {
  const previousGetAppState = modifiedContext.getAppState
  modifiedContext = {
    ...modifiedContext,
    getAppState() {
      const appState = previousGetAppState()
      return {
        ...appState,
        toolPermissionContext: {
          ...appState.toolPermissionContext,
          alwaysAllowRules: {
            ...appState.toolPermissionContext.alwaysAllowRules,
            command: allowedTools,  // 覆盖允许的命令列表
          },
        },
      }
    },
  }
  // 如果有 model 覆盖，同样注入
  return modifiedContext
}
```

---

## Fork 执行路径详解

当 `command.context === 'fork'` 时，[src/tools/SkillTool/SkillTool.ts:121-288](../src/tools/SkillTool/SkillTool.ts#L121-L288) 里的 `executeForkedSkill()` 接管：

```typescript
async function executeForkedSkill(
  command,
  commandName,
  args,
  context,
  canUseTool,
  parentMessage,
  onProgress?,
) {
  const agentId = createAgentId()
  const startTime = Date.now()

  // 准备子 Agent 的上下文（包括 skill 内容作为提示词）
  const { modifiedGetAppState, baseAgent, promptMessages, skillContent } =
    await prepareForkedCommandContext(command, args || '', context)

  // 如果 skill 有 effort 设置，注入到 agent 定义
  const agentDefinition = command.effort !== undefined
    ? { ...baseAgent, effort: command.effort }
    : baseAgent

  const agentMessages: Message[] = []

  // 运行子 Agent（和 AgentTool 的 fork path 一样）
  for await (const message of runAgent({
    agentDefinition,
    promptMessages,
    toolUseContext: { ...context, getAppState: modifiedGetAppState },
    canUseTool,
    isAsync: false,
    querySource: 'agent:custom',
    model: command.model as ModelAlias | undefined,
    availableTools: context.options.tools,
    override: { agentId },
  })) {
    agentMessages.push(message)

    // 报告进度（像 AgentTool 一样）
    if ((message.type === 'assistant' || message.type === 'user') && onProgress) {
      const normalizedNew = normalizeMessages([message])
      for (const m of normalizedNew) {
        if (m.message.content.some(c => c.type === 'tool_use' || c.type === 'tool_result')) {
          onProgress({
            toolUseID: `skill_${parentMessage.message.id}`,
            data: { message: m, type: 'skill_progress', prompt: skillContent, agentId },
          })
        }
      }
    }
  }

  // 从子 Agent 的消息历史中提取最终文本
  const resultText = extractResultText(agentMessages, 'Skill execution completed')
  agentMessages.length = 0  // 释放内存

  return {
    data: {
      success: true,
      commandName,
      status: 'forked',
      agentId,
      result: resultText,
    },
  }
}
```

Fork 执行的关键特点：
1. `runAgent()` 启动一个完整的子 Agent，有自己的 token 预算和 query loop
2. 子 Agent 的消息通过 `onProgress` 回调实时报告给 UI（用户能看到子 Agent 的工具调用）
3. 执行完后通过 `extractResultText()` 提取最终结果文本，只把这段文本返回给主 Agent
4. `agentMessages.length = 0` 在结果提取后立即清空，释放内存（子 Agent 可能有大量消息）
5. `clearInvokedSkillsForAgent(agentId)` 释放 skill 内容（在 `finally` 块保证执行）

**内联 vs Fork 的 outputSchema 区别**：

```typescript
// 内联 skill 的输出
const inlineOutputSchema = z.object({
  success: z.boolean(),
  commandName: z.string(),
  allowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  status: z.literal('inline').optional(),
})

// Fork skill 的输出
const forkedOutputSchema = z.object({
  success: z.boolean(),
  commandName: z.string(),
  status: z.literal('forked'),
  agentId: z.string(),
  result: z.string(),  // 子 Agent 的完整执行结果文本
})
```

内联 skill 没有 `result` 字段——它的"结果"是通过 `newMessages` 注入到对话历史里，Claude 直接看对话历史就能了解执行结果。Fork skill 有 `result` 字段——子 Agent 的工作在隔离环境里完成，结果文本是唯一传回主 Agent 的信息。

---

## 完整执行流程图

```
Claude: SkillTool({ skill: "review-pr", args: "123" })
    │
    ▼
validateInput()
    │ skill 存在？是 prompt 类型？没有 disableModelInvocation？
    ▼
checkPermissions()
    │ deny 规则？allow 规则？安全属性自动允许？询问用户？
    ▼
call()
    │
    ├── 有 context: 'fork'？
    │       │
    │      是 → executeForkedSkill()
    │               │
    │           prepareForkedCommandContext()
    │               │
    │           skill 内容 → promptMessages
    │               │
    │           runAgent()（独立子 Agent）
    │               │
    │           extractResultText()
    │               │
    │           返回 { status: 'forked', result: "..." }
    │
    └── 默认内联
            │
        processPromptSlashCommand()
            │
        getPromptForCommand()
            ↓
        模板替换 + shell 命令执行
            ↓
        包装成 user message（newMessages）
            ↓
        contextModifier（临时修改工具集/模型）
            ↓
        返回 { status: 'inline' } + newMessages
            │
            ▼
    skill 内容作为 user message 注入对话历史
            │
            ▼
    Claude 的下一次 API 调用包含这条消息
            │
            ▼
    Claude 读取并执行 skill 的指令
```

---

## 本章小结

SkillTool 的执行流程：
1. **validateInput**：skill 存在、是 prompt 类型、没有 disableModelInvocation
2. **checkPermissions**：deny/allow 规则 → 安全属性自动允许 → 询问用户
3. **路由**：`context: 'fork'` → 子 Agent 独立执行；否则 → 内联注入
4. **内联**：skill 内容变成 user message 注入对话，`contextModifier` 临时修改工具集
5. **Fork**：`runAgent()` + `extractResultText()`，只返回最终结果文本

内联 vs Fork 的本质区别：内联共享主对话的 token 预算和工具集；Fork 在独立 Agent 里执行，避免 token 污染。

## 前后引用

- Fork 执行用到的 `runAgent()` 完整实现，在 **[14-2 节](./14-2-AgentTool派发子Agent的工具.md)** 详解
- skill 列表如何出现在 System Prompt / system-reminder 里，在 **[16-4 节](./16-4-Skills和SystemPrompt的关系.md)** 详解

## 下一节预告

下一节解答：Claude 是怎么知道有哪些 skills 可用的？skills 的名字和描述是怎么进入 Claude 的上下文的？`SKILL_BUDGET_CONTEXT_PERCENT` 预算机制如何防止大量 skills 撑爆 System Prompt？

➡️ [下一节：16-4 Skills 和 System Prompt 的关系](./16-4-Skills和SystemPrompt的关系.md)
