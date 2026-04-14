# 10-4 submitMessage() 的完整序列图

## 本节要解决的问题

本章已经分散地讲解了 `QueryEngine`、`query()`、`queryLoop()` 的各个部分。现在把它们全部串联起来，画出一幅从用户输入到 SDK 调用者收到结果的**完整序列图**。

这张序列图是本课程第八、九、十章的总结，也是你理解整个"主流程"的最终地图。

---

## 角色说明

```
SDK Caller     — SDK 调用者（或 REPL.tsx 里的 ask()）
QueryEngine    — 会话状态持有者
submitMessage  — QueryEngine 的方法（每次用户输入触发）
query()        — command lifecycle 包装层
queryLoop()    — while(true) 状态机
callModel()    — Anthropic API 调用（queryModel()）
runTools()     — 工具执行编排
```

---

## 完整序列图

```
SDK Caller                QueryEngine              query()           queryLoop()          API / Tools
    │                         │                      │                   │                    │
    │ submitMessage("prompt")  │                      │                   │                    │
    ├────────────────────────►│                      │                   │                    │
    │                         │                      │                   │                    │
    │                         │ [1] 包装 canUseTool  │                   │                    │
    │                         │ [2] 获取初始 model   │                   │                    │
    │                         │ [3] fetchSystemPromptParts()             │                    │
    │                         │───────────────────────────────────────────────────────────────►
    │                         │◄───────────────────────────────────────────────────────────────
    │                         │ [4] 构建 systemPrompt                    │                    │
    │                         │                      │                   │                    │
    │                         │ [5] processUserInput("prompt")           │                    │
    │                         │───────────────────────────────────────────────────────────────►
    │                         │◄─────────────────────────────────────────────────────────────── 
    │                         │   slash命令结果/allowedTools              │                    │
    │                         │                      │                   │                    │
    │                         │ [6] mutableMessages.push(userMsg)        │                    │
    │                         │                      │                   │                    │
    │                         │ [7] recordTranscript (BEFORE API)        │                    │
    │                         │                      │                   │                    │
    │                         │ [8] skills/plugins 缓存                  │                    │
    │                         │                      │                   │                    │
    │ ◄── yield system/init   │                      │                   │                    │
    │                         │                      │                   │                    │
    │                         │ ── [9] for await (query({messages,...})) ►│                  │
    │                         │                      │─ [yield*] ──────► │                    │
    │                         │                      │                   │                    │
    │                         │ ═══════════════ while(true) 循环开始 ═══════════════════════   │
    │                         │                      │                   │                    │
    │                         │                      │                   │[A] blocking_limit?  │
    │                         │                      │                   │ 否 ↓                │
    │                         │                      │                   │[B] callModel()     │
    │                         │                      │                   │───────────────────►│
    │                         │                      │                   │                    │ (API 流式)
    │                         │                      │                   │◄── stream_event ───┤
    │                         │ ◄── stream_event     │◄── stream_event ──┤                    │
    │ ◄── (optional) stream   │                      │                   │                    │
    │                         │                      │                   │◄── stream_event ───┤
    │                         │◄── SDKAssistantMsg ──│◄── AssistantMsg ──┤ (content_block_stop)
    │ ◄── SDKAssistantMsg      │                      │                   │                    │
    │                         │ mutableMessages.push │                   │                    │
    │                         │ recordTranscript()   │                   │                    │
    │                         │                      │                   │                    │
    │                         │                      │                   │[C] needsFollowUp?  │
    │                         │                      │                   │  true ↓            │
    │                         │                      │                   │[D] runTools(...)   │
    │                         │                      │                   │───────────────────►│
    │                         │                      │                   │◄─── tool results ──┤
    │                         │◄── SDKUserMsg        │◄── UserMsg        │                    │
    │ ◄── SDKUserMsg           │                      │                   │                    │
    │                         │ mutableMessages.push │                   │                    │
    │                         │                      │                   │                    │
    │                         │                      │                   │[E] state = next    │
    │                         │                      │                   │    continue        │
    │                         │                      │                   │                    │
    │                         │ ═══════════════ 下一次循环（可能多轮）════════════════════════  │
    │                         │                      │                   │                    │
    │                         │                      │                   │[F] needsFollowUp=false
    │                         │                      │                   │[G] handleStopHooks │
    │                         │◄── SDKAssistantMsg ──│◄── AssistantMsg ──┤                    │
    │ ◄── SDKAssistantMsg      │                      │                   │                    │
    │                         │                      │                   │[H] return Terminal │
    │                         │◄────────────────────────────────────────┤                    │
    │                         │                      │                   │                    │
    │                         │ ═══════════════ query() 清理 =═══════════════════════════════  │
    │                         │                      │ notifyCommandLifecycle(uuid, 'completed')
    │                         │                      │                   │                    │
    │                         │ [10] 构建 result 消息 │                   │                    │
    │ ◄── SDKResultMessage     │                      │                   │                    │
    │                         │                      │                   │                    │
```

---

## 10 个关键步骤详解

### 步骤 1-4：准备阶段

```typescript
// [1] 追踪权限拒绝
const wrappedCanUseTool: CanUseToolFn = async (...) => {
  const result = await canUseTool(...)
  if (result.behavior !== 'allow') {
    this.permissionDenials.push(...)  // 记录本次被拒绝的工具
  }
  return result
}

// [2] 解析模型
const mainLoopModel = modelFromUserInput ?? initialMainLoopModel

// [3] 并行获取系统提示部分
const { defaultSystemPrompt, userContext, systemContext } =
  await fetchSystemPromptParts({ tools, mainLoopModel, ... })

// [4] 组装 systemPrompt（string[]）
const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

### 步骤 5-6：处理用户输入

```typescript
// [5] 斜杠命令处理、消息解析
const { messages: messagesFromUserInput, shouldQuery, ... } =
  await processUserInput({ input: prompt, ... })

// [6] 追加到消息历史（包括斜杠命令产生的附件等）
this.mutableMessages.push(...messagesFromUserInput)
```

### 步骤 7：早期 transcript 写入

```typescript
// [7] 在 API 调用之前写入 transcript！
// 如果进程在 API 响应之前被杀死，也能恢复
if (persistSession && messagesFromUserInput.length > 0) {
  await recordTranscript(messages)
}
```

这是一个关键设计：**transcript 写入发生在 API 调用之前**，而不是之后。如果用户中途关闭 Claude Code，下次 `--resume` 时仍然能恢复到用户消息已发送、但 Claude 还没回复的状态。

### 步骤 8-9：进入 query 循环

```typescript
// [8] 异步加载 skills 和 plugins（不阻塞）
const [skills, { enabled: enabledPlugins }] = await Promise.all([
  getSlashCommandToolSkills(getCwd()),
  loadAllPluginsCacheOnly(),
])

// [9] yield 初始化消息（SDK 调用者的第一条消息）
yield buildSystemInitMessage({ tools, model, permissionMode, ... })

// shouldQuery = false（斜杠命令，本地处理）→ 直接返回 result，不调用 API
// shouldQuery = true → 进入 query()
for await (const message of query({ messages, systemPrompt, ... })) {
  // 处理各类消息...
}
```

### 步骤 A-H：queryLoop() 内部循环

这部分已在第 9 章详细讲解，这里只做高层概括：

- **A**：每轮迭代前检查 blocking_limit（预防性上下文溢出检测）
- **B**：`callModel()` → Anthropic API 流式响应
- **C**：`needsFollowUp` 判断是否有工具调用
- **D**：`runTools()` 并发/串行执行工具
- **E**：构建下一轮 state，`continue` 进入下一次迭代
- **F**：没有工具调用时，检查 stop hooks
- **G**：`handleStopHooks()` 运行 PostToolUse hook
- **H**：`return Terminal`，结束状态机

### 步骤 10：构建 result 消息

```typescript
// 根据 terminal.reason 构建不同的 SDKResultMessage：
yield {
  type: 'result',
  subtype: terminal.reason === 'completed' ? 'success' : 'error_...',
  stop_reason: terminal.reason,
  result: lastAssistantText,
  total_cost_usd: getTotalCost(),
  usage: this.totalUsage,
  permission_denials: this.permissionDenials,
  duration_ms: Date.now() - startTime,
  num_turns: turnCount,
}
```

---

## 关键消息类型的 yield 时序

```
SDK 调用者收到消息的顺序：

1. SDKSystemMessage (system/init)  ← 固定第一条，包含工具列表、模型等信息
                                      SDK 调用者可以用这条消息知道"本次会话用的什么模型"

2. [循环开始]
   ├── SDKAssistantMessage         ← Claude 的 text/thinking/tool_use block（每个 block 一条）
   ├── SDKUserMessage              ← 工具结果（每个工具一条）
   ├── SDKToolUseSummaryMessage    ← 可选：工具执行摘要（用 Haiku 生成）
   └── ... （多轮循环）

3. SDKResultMessage               ← 最后一条，总结整个 session
```

---

## 两种中断场景下的序列

### 场景一：shouldQuery = false（斜杠命令）

```
SDK Caller    → submitMessage("/compact")
                    │
                    ▼
              processUserInput → 处理 /compact 命令
                    │
                    ▼
              yield system/init
                    │
                    ▼
              for (msg of messagesFromUserInput) {
                yield msg   // 本地命令输出
              }
                    │
                    ▼
              yield result { subtype: 'success', stop_reason: null }
              return  // 不调用 API！
```

### 场景二：用户中途中断（Ctrl+C）

```
SDK Caller    → submitMessage("帮我重构所有文件")
                    │
queryLoop 正在执行工具...
                    │
用户按 Ctrl+C → abortController.abort()
                    │
queryLoop: if (abortController.signal.aborted)
           → return { reason: 'aborted_tools' }
                    │
query(): notifyCommandLifecycle(uuid, 'completed') 不执行（terminal 通过 yield* 传回）
                    │
QueryEngine: for-await 循环结束（query 的 generator return 了）
                    │
yield result { subtype: 'success', stop_reason: 'aborted_tools' }
```

注意：即使被中断，SDK 调用者**仍然**会收到一个 `SDKResultMessage`，`stop_reason` 是 `'aborted_tools'`。这样 SDK 调用者总能知道会话是如何结束的，不会陷入"不知道有没有结束"的歧义状态。

---

## 多轮对话的消息历史增长示意

```
第 1 次 submitMessage("写一个 bubble sort"):
  API 收到: [user: "写一个 bubble sort"]
  
  API 返回: assistant → needsFollowUp=false → completed
  
  mutableMessages: [user1, assistant1]


第 2 次 submitMessage("加上注释"):
  API 收到: [user1, assistant1, user: "加上注释"]
  
  API 返回: assistant(tool_use: Read main.ts) → needsFollowUp=true
           → runTools → tool_result
           → assistant2 → completed
  
  mutableMessages: [user1, assistant1, user2,
                    assistant2_with_tool_use, user_tool_result,
                    assistant3_with_text]


第 3 次 submitMessage("现在加错误处理"):
  API 收到: [user1, assistant1, user2, ..., assistant3,
             user: "现在加错误处理"]
  
  ... （Claude 的"记忆"包含前两轮的完整历史）
```

---

## 本章总结

从本章（第 10 章）的角度看，整个"主流程"是一个**三层嵌套的关注点分离**：

| 层级 | 组件 | 关注点 |
|---|---|---|
| 最外层 | QueryEngine | 多轮会话状态（mutableMessages、用量统计、transcript） |
| 中间层 | submitMessage() | 单轮交互编排（processUserInput、格式化、SDKMessage 转换） |
| 内层 | query() + queryLoop() | 单轮 API 交互（状态机、工具执行、错误恢复） |

每一层只处理它自己的关注点，层层委托给下一层。调用者（SDK 调用者或 REPL）只需要和最外层交互，内部复杂性被完全封装。

---

## 前后呼应

- 步骤 3（fetchSystemPromptParts）在 **[8-3 节](./8-3-System-Prompt的构建.md)** 详细讲解
- 步骤 5（processUserInput）在 **[8-2 节](./8-2-processUserInput消息预处理.md)** 详细讲解
- 步骤 7（早期 transcript）在 **[8-4 节](./8-4-submitMessage的前半程.md)** 有说明
- 步骤 A-H（queryLoop 内部）是整个第 9 章的内容

## 第十章小结

第 10 章从架构角度讲解了 QueryEngine 的设计：

- **10-1**：为什么需要两层（query 的薄层包装 vs QueryEngine 的会话管理）
- **10-2**：mutableMessages 的生命周期（增长、compact 修剪、snip 截断）
- **10-3**：SDK 与 TUI 的统一接口（normalizeMessage 格式转换，stream_event 消费差异）
- **10-4**：完整序列图（串联所有组件的时序关系）

➡️ **下一章**：权限系统——Claude 如何决定某个工具调用是否允许执行？

➡️ [第十一章：11-1 为什么需要权限系统？不加会怎样？](./11-1-为什么需要权限系统.md)
