# 14-6 Fork 子 Agent 与 Coordinator 模式

## 问题引入：两种"多 Agent 编排"的哲学差异

到目前为止，第 14 章讲的都是一种多 Agent 模式：
**主 Agent 明确地派发子 Agent**（AgentTool），子 Agent 有独立的系统提示和上下文。

但实际工作中有一种更自然的场景：主 Agent 正在解决一个任务，分析到一半发现"这部分可以并行处理"。它不需要给每个子 Agent 写独立的任务描述，因为子 Agent 就是"自己的一部分"，应该直接继承当前的整个对话上下文，只是负责不同的子任务。

这就是 **Fork 子 Agent**：不是派发一个独立的 Agent，而是把自己的对话 **"分叉"**，多个副本各自处理一个子任务。

Fork 和普通 AgentTool 的核心区别：

| 维度 | AgentTool (subagent_type 指定) | Fork 子 Agent (无 subagent_type) |
|------|-------------------------------|----------------------------------|
| 上下文 | 独立初始化，从空开始 | 继承完整父会话历史 |
| 系统提示 | 子 Agent 自己的 | 与父完全相同（字节一致） |
| 工具列表 | 独立组装 | 与父完全相同 |
| Prompt cache | 独立 cache | 共享父 Agent 的 cache |
| 使用场景 | 专业化分工 | 并行化探索 |

---

## 一、buildForkedMessages()：让所有 Fork 共享 cache 前缀

Fork 的核心工程挑战是：**如何让多个并行的 Fork 子 Agent 命中同一个 prompt cache？**

如果每个 Fork 子 Agent 发给 API 的消息前缀略有不同，它们就无法共享 cache，每个 Fork 都要重新处理完整的历史，费用是普通请求的 N 倍。

解决方案在 `buildForkedMessages()` 里：

**文件：[src/tools/AgentTool/forkSubagent.ts](../src/tools/AgentTool/forkSubagent.ts#L107-L168)**

```typescript
export function buildForkedMessages(
  directive: string,         // 这个 Fork 子 Agent 的具体任务
  assistantMessage: AssistantMessage,  // 当前 Claude 的回复（包含所有 tool_use 块）
): MessageType[] {
  // 1. 完整保留当前 assistant 消息（包括所有 tool_use 块，原封不动）
  const fullAssistantMessage = { ...assistantMessage, uuid: randomUUID(), ... }

  // 2. 为 assistant 消息里的每个 tool_use 构造相同的占位 tool_result
  const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: [{ type: 'text', text: FORK_PLACEHOLDER_RESULT }],  // 所有 Fork 相同！
  }))

  // 3. 构造一条用户消息：
  //    [占位 tool_results（所有 Fork 完全相同）] + [具体指令（每个 Fork 不同）]
  const toolResultMessage = createUserMessage({
    content: [
      ...toolResultBlocks,         // ← 所有 Fork 共享这部分（cache 命中）
      {
        type: 'text',
        text: buildChildMessage(directive),  // ← 每个 Fork 不同（cache 不命中这一块）
      },
    ],
  })

  return [fullAssistantMessage, toolResultMessage]
}
```

发给 API 的完整消息序列是：

```
[...父会话历史（shared）]
[assistant: 所有 tool_use 块（shared）]
[user: 占位 tool_results + 子 Agent 指令（前半相同，后半不同）]
```

**所有 Fork 子 Agent 的请求前缀完全相同**，只在最后一条消息的 directive 部分不同。Anthropic API 的 prompt cache 以消息前缀为 key，只要前缀一样，后续的 token 处理就能命中 cache。

---

## 二、buildChildMessage()：给 Fork 子 Agent 的行为约束

Fork 子 Agent 继承了父 Agent 的系统提示。但父 Agent 的系统提示里有"当任务可并行时，主动分叉"这样的指令——Fork 子 Agent 不能再次 fork（否则无限递归）。

为了给 Fork 子 Agent 注入新的行为约束，`buildChildMessage()` 构造了一段包含在 `<fork_boilerplate_tag>` 里的指令：

**文件：[src/tools/AgentTool/forkSubagent.ts](../src/tools/AgentTool/forkSubagent.ts#L171-L198)**

```typescript
export function buildChildMessage(directive: string): string {
  return `<fork_boilerplate_tag>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT — that's for the parent.
   You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope.
8. Keep your report under 500 words unless specified otherwise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format:
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings>
  Key files: <relevant file paths>
  Files changed: <list with commit hash — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</fork_boilerplate_tag>

[FORK DIRECTIVE]: ${directive}`
}
```

这段指令非常具体，它：
1. 明确告知子 Agent "你不是主 Agent，不要继续 fork"（防递归）
2. 强制输出结构化格式（便于主 Agent 解析汇总）
3. 禁止闲聊（减少 token 浪费）
4. 要求提交后报告 commit hash（方便追踪修改）

---

## 三、isInForkChild()：递归守卫

Fork 子 Agent 继承了父 Agent 的工具列表（包括 AgentTool），它仍然可以"看到"可以 fork 的选项。递归守卫防止它真的去 fork：

**文件：[src/tools/AgentTool/forkSubagent.ts](../src/tools/AgentTool/forkSubagent.ts#L78-L89)**

```typescript
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false
    const content = m.message.content
    if (!Array.isArray(content)) return false
    return content.some(
      block =>
        block.type === 'text' &&
        block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    )
  })
}
```

检测方式是扫描消息历史，看有没有 `<fork_boilerplate_tag>`（即 `buildChildMessage()` 注入的那段文字）。如果有，说明当前正在 Fork 子 Agent 里，拒绝再次 fork。

这和第 13-2 节里 `querySource === 'compact'` 的检查是类似的防御机制——一个通过字符串检查 querySource，一个通过扫描消息历史。Fork 路径同时使用两种守卫（[AgentTool.tsx#L332](../src/tools/AgentTool/AgentTool.tsx#L332)）：

```typescript
if (
  toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}`
  || isInForkChild(toolUseContext.messages)  // 消息历史扫描（备用检查）
) {
  throw new Error('Fork is not available inside a forked worker.')
}
```

为什么同时用两种？注释说明了原因：`querySource` 是"compaction-resistant"的——即使 autocompact 重写了消息历史，querySource 也不会变（它存在 `options` 对象里，不在消息里）。消息历史扫描是备用方案，用于处理 querySource 没有正确传递的边缘情况。

---

## 四、Coordinator 模式：另一种多 Agent 编排

**文件：[src/coordinator/coordinatorMode.ts](../src/coordinator/coordinatorMode.ts)**

Coordinator 模式是一个完全不同的多 Agent 编排框架，通过环境变量开启：

```typescript
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

在 Coordinator 模式下，Claude Code 的行为变成一个"指挥中心"：

```
用户任务
  │
  ▼
Coordinator Agent（主线程 Claude）
  │  分析任务，拆分子任务
  │  派发给 Worker Agent（通过 AgentTool）
  │
  ├─ Worker 1（异步后台，受限工具池）
  ├─ Worker 2（异步后台，受限工具池）
  └─ Worker 3（异步后台，受限工具池）
        │
        ▼（完成通知）
  Coordinator Agent（汇总结果，继续下一阶段）
```

与普通多 Agent 的关键区别：

1. **所有 Worker 都是异步的**：`shouldRunAsync = ... || isCoordinator || ...`，Coordinator 模式下任何子 Agent 都被强制异步运行
2. **Worker 工具池受限**：Worker 只有 `ASYNC_AGENT_ALLOWED_TOOLS` 里的工具（Bash, Read, Write, FileEdit, Grep, Glob 等），没有 AgentTool 本身（防止 Worker 再派发子 Agent）
3. **Coordinator 有辅助上下文**：主线程 Claude 会被注入 Worker 的工具能力列表，帮它写更精准的任务描述

Worker 工具限制在 `resolveAgentTools()` 里实现：

```typescript
// agentToolUtils.ts
if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
  return false  // 异步 Agent 只能用允许列表里的工具
}
```

`ASYNC_AGENT_ALLOWED_TOOLS` 是一个精心挑选的工具集合——只包含文件操作和 shell 命令，不包含 AgentTool、TaskStop 等管理类工具，确保 Worker 老老实实做自己的子任务，不会"越界"。

---

## 五、Fork 模式 vs Coordinator 模式的对比

```
                    Fork 模式               Coordinator 模式
─────────────────────────────────────────────────────────────
触发方式         omit subagent_type         CLAUDE_CODE_COORDINATOR_MODE=1
上下文           继承父会话完整历史          各 Worker 独立初始化
通信方式         结构化报告（文本）           task-notification
Cache 共享       ✅（共享父 cache）          ❌（各自独立）
Worker 能力      完整工具池                  受限工具池
适合场景         并行探索（相同知识库）       批量独立任务
当前状态         实验性（feature gate）       实验性（env var）
```

Fork 模式更适合"并行但高度相关"的任务（比如同时搜索多个代码模式），每个子 Agent 都需要完整的历史上下文。

Coordinator 模式更适合"可完全独立"的子任务（比如给 50 个模块各自写单测），每个 Worker 只需要自己的子任务描述。

---

## 本节小结

Fork 子 Agent 通过 `buildForkedMessages()` 实现 prompt cache 共享：所有 Fork 的消息前缀完全相同（只有最后的 directive 不同），让并行 Fork 共享同一个 prompt cache，大幅减少 token 开销。`buildChildMessage()` 注入行为约束阻止子 Agent 继续 fork，`isInForkChild()` 提供消息历史级别的递归守卫。Coordinator 模式提供了完全不同的多 Agent 编排哲学：主线程作为指挥官，所有 Worker 异步运行，通过 task-notification 同步结果。

## 下一节预告

除了主/子 Agent 这种层级关系，Claude Code 还支持"同级 Teammate"模式——多个 Agent 在同一个进程里运行，通过 AsyncLocalStorage 隔离，可以互相发消息，就像一个小团队一起工作。

➡️ [下一节：14-7 Swarm 模式与 Teammate 模式](./14-7-Swarm模式与Teammate模式.md)
