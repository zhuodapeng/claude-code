# 14-1 什么是多 Agent？为什么单 Agent 不够？

## 问题引入：一个 Claude 干不完的事

设想你让 Claude Code 做这件事：

> "帮我把整个前端重构成新版本的设计系统，涉及 300 个组件，同时写测试，同时更新文档。"

单 Agent 面对这个任务，会遇到几道墙：

**墙一：Context 窗口撑爆。** 读完 300 个文件，来回沟通修改，消息历史会轻松突破 200K token。第 13 章讲过压缩机制，但压缩有损，且压缩本身也有极限。

**墙二：任务是可并行的，但执行是串行的。** "给这 10 个模块各写单测"这种任务，逻辑上可以同时开工，但单 Agent 只能一个一个来，每个工具调用都要等待 Claude 生成、执行、再生成。

**墙三：同一个 Claude 不适合所有子任务。** "搜索代码库有哪些调用点"和"根据搜索结果写一份架构文档"是截然不同的认知任务。前者需要大量工具调用，后者需要总结能力。用同一套 System Prompt 和对话历史处理两件完全不同的事，效率很低。

**多 Agent 系统**就是为解决这三道墙而设计的：用多个独立的 Claude 实例分工协作，每个实例有自己独立的 Context 窗口、自己的 System Prompt、自己的工具授权，互相通过消息传递结果。

---

## Claude Code 的多 Agent 架构全景

Claude Code 的多 Agent 系统由以下组件构成：

```
主 Agent（主线程 query 循环）
  │
  ├─ AgentTool（唯一的派发入口）
  │   ├─ 同步子 Agent（runAgent, 阻塞主线程直到完成）
  │   ├─ 异步后台 Agent（runAgent + LocalAgentTask, 立即返回）
  │   ├─ Fork 子 Agent（runAgent + FORK_AGENT, 继承父会话上下文）
  │   └─ 远程 Agent（teleportToRemote, ant 内部专用）
  │
  ├─ runForkedAgent（轻量级 fork，用于内部服务）
  │   ├─ compactConversation (querySource='compact')
  │   ├─ session_memory (querySource='session_memory')
  │   ├─ promptSuggestion (querySource='promptSuggestion')
  │   └─ /btw 命令等
  │
  └─ Coordinator/Swarm（实验性多 Agent 框架）
      ├─ CoordinatorMode（工作线程池模式）
      └─ InProcessTeammate（同进程 Teammate，AsyncLocalStorage 隔离）
```

这里有两个容易混淆的概念需要先区分清楚：

**`AgentTool` vs `runForkedAgent`**

| 维度 | AgentTool | runForkedAgent |
|------|-----------|----------------|
| 调用方 | Claude（通过工具调用） | Claude Code 内部代码 |
| 用途 | 用户可见的子任务派发 | 内部服务（压缩、记忆等） |
| 会话历史 | 独立初始化（无父历史） | 继承父会话历史 |
| 系统提示 | 用 Agent 自己的系统提示 | 与父共享（cache 复用） |
| 主入口 | `src/tools/AgentTool/AgentTool.tsx` | `src/utils/forkedAgent.ts` |

`runForkedAgent` 是一个低层工具，它把父会话的所有消息和系统提示原封不动地传给子 Claude，目的是复用 prompt cache（节省 token 费用）。第 13 章里的压缩 Agent 就用了它。

`AgentTool` 则是完全独立的 Claude 实例——它有自己的系统提示，从一条用户消息开始，不知道也不需要知道主线程正在讨论什么。

---

## 从 Claude 的视角看：如何调用 Agent

Claude 调用 Agent 的方式和调用其他工具完全一样，通过 `tool_use` 块：

```json
{
  "type": "tool_use",
  "name": "Agent",
  "input": {
    "description": "Explore codebase structure",
    "prompt": "Find all TypeScript files that export React components. Report file paths, component names, and their props.",
    "subagent_type": "Explore",
    "run_in_background": false
  }
}
```

参数说明：
- `description`：3-5 词的任务摘要（用于 UI 显示，也出现在 task notification 里）
- `prompt`：交给子 Agent 的完整任务描述
- `subagent_type`：指定用哪种 Agent（内置的 Explore、Plan，或用户自定义的 agent 名称）
- `run_in_background`：是否异步执行

Agent 工具同时支持旧名称 `Task`（向后兼容），通过 [aliases](../src/tools/AgentTool/AgentTool.tsx#L228) 实现。

---

## AgentDefinition：什么是"一个 Agent"

在 Claude Code 里，"一个 Agent"不是一个运行中的进程，而是一个**定义（AgentDefinition）**——描述如何初始化一个 Claude 实例：

**文件：[src/tools/AgentTool/loadAgentsDir.ts](../src/tools/AgentTool/loadAgentsDir.ts#L106-L133)**

```typescript
export type BaseAgentDefinition = {
  agentType: string           // 唯一标识符，如 "Explore", "my-custom-agent"
  whenToUse: string           // 给主线程 Claude 看的描述，帮它决定何时选这个 agent
  tools?: string[]            // 工具白名单（可用 "*" 表示全部）
  disallowedTools?: string[]  // 工具黑名单
  skills?: string[]           // 预加载的 skill 名称
  mcpServers?: AgentMcpServerSpec[]  // 该 agent 专用的 MCP 服务器
  hooks?: HooksSettings       // session 级别的 hooks
  model?: string              // 模型覆盖（可以用 "inherit" 继承父 agent 模型）
  permissionMode?: PermissionMode  // 权限模式
  maxTurns?: number           // 最大 API 轮次
  background?: boolean        // 永远以后台方式运行
  isolation?: 'worktree' | 'remote'  // 运行环境隔离
  memory?: AgentMemoryScope   // 持久记忆范围
  omitClaudeMd?: boolean      // 不加载 CLAUDE.md（节省 token）
}
```

`omitClaudeMd` 有一个有趣的注释（[L131](../src/tools/AgentTool/loadAgentsDir.ts#L131)）：

```
/** Omit CLAUDE.md hierarchy from the agent's userContext. Read-only agents
 * (Explore, Plan) don't need commit/PR/lint guidelines — the main agent has
 * full CLAUDE.md and interprets their output. Saves ~5-15 Gtok/week across
 * 34M+ Explore spawns. */
```

**每周节省 5-15 Gtok（gigatoken）**——这是 Anthropic 从生产遥测里看到的真实数字，印证了 Explore Agent 被调用极为频繁（3400 万次+ Explore spawn），即使每次只节省几百 token，乘以亿级调用量也非常可观。

---

## 三种 AgentDefinition 来源

**文件：[src/tools/AgentTool/loadAgentsDir.ts](../src/tools/AgentTool/loadAgentsDir.ts#L136-L165)**

```typescript
// 内置 Agent（编译进代码里的，固定提示词）
type BuiltInAgentDefinition = BaseAgentDefinition & {
  source: 'built-in'
  getSystemPrompt: (params) => string  // 函数形式，可根据上下文动态生成
}

// 自定义 Agent（用户在 .claude/agents/ 目录下写的 .md 文件）
type CustomAgentDefinition = BaseAgentDefinition & {
  source: SettingSource  // 'userSettings' | 'projectSettings' | 'policySettings'
  getSystemPrompt: () => string       // 闭包，从文件读取
}

// 插件 Agent（插件提供的）
type PluginAgentDefinition = BaseAgentDefinition & {
  source: 'plugin'
  plugin: string           // 插件标识符
  getSystemPrompt: () => string
}
```

三者都通过 `getSystemPrompt()` 获取系统提示，但来源不同：
- 内置 Agent：代码里硬编码（如 Explore、Plan、General-Purpose）
- 自定义 Agent：用户在 `~/.claude/agents/` 或 `.claude/agents/` 目录下写的 Markdown 文件
- 插件 Agent：由 Claude Code 插件提供

---

## 优先级规则：同名 Agent 谁赢？

**文件：[src/tools/AgentTool/loadAgentsDir.ts](../src/tools/AgentTool/loadAgentsDir.ts#L193-L205)**

```typescript
export function getActiveAgentsFromList(allAgents): AgentDefinition[] {
  const builtInAgents  = allAgents.filter(a => a.source === 'built-in')
  const pluginAgents   = allAgents.filter(a => a.source === 'plugin')
  const userAgents     = allAgents.filter(a => a.source === 'userSettings')
  const projectAgents  = allAgents.filter(a => a.source === 'projectSettings')
  // ...
  // 优先级：project > user > plugin > built-in
  // 同层次内，后定义的覆盖先定义的
}
```

这个优先级让项目级配置能够覆盖用户级配置，用户级配置能够覆盖内置 Agent。实际工作中，你可以在项目的 `.claude/agents/Explore.md` 里自定义 Explore Agent 的提示词，完全替换掉内置版本。

---

## 本节小结

Claude Code 的多 Agent 系统解决了单 Agent 的三个核心限制：Context 窗口、并行性、专业化。所有用户可见的 Agent 调用都通过 `AgentTool`（即 "Agent" 工具）进行；内部服务用 `runForkedAgent`。一个 Agent 的本质是 `AgentDefinition`——一个包含提示词、工具列表、权限模式的配置对象，来源可以是内置、用户自定义或插件。

## 下一节预告

下一节我们深入 `AgentTool.tsx`——它的输入输出 schema、内部路由逻辑，以及 Agent 从"被选中"到"开始执行"之间经历了哪些步骤。

➡️ [下一节：14-2 AgentTool：派发子 Agent 的工具](./14-2-AgentTool派发子Agent的工具.md)
