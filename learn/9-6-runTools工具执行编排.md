# 9-6 runTools()：工具执行编排

## 本节要解决的问题

Claude 在一次响应里可能调用多个工具。系统需要决定：哪些工具可以**并发**执行（加快速度），哪些必须**串行**执行（保证正确性）。

错误的并发策略会导致灾难：两个写操作同时修改同一个文件，结果损坏；一个工具的输出是另一个工具的输入，并发会导致顺序错乱。

**文件：[src/services/tools/toolOrchestration.ts](../src/services/tools/toolOrchestration.ts)**

---

## partitionToolCalls()：分批策略

**文件：[src/services/tools/toolOrchestration.ts](../src/services/tools/toolOrchestration.ts#L91-L116)**

核心思路：把工具调用列表分成多个**批次（Batch）**，每个批次要么是单个"不安全"工具，要么是多个"并发安全"工具。

```typescript
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const isConcurrencySafe = tool?.isConcurrencySafe(parsedInput.data) ?? false
    
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      // 上一批也是并发安全的 → 合并进去
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      // 否则 → 新开一批
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}
```

结果示例：

```
工具调用列表：[Read, Read, Bash, Read, Edit]

→ 分批结果：
  Batch 1: { isConcurrencySafe: true,  blocks: [Read, Read] }  → 并发执行
  Batch 2: { isConcurrencySafe: false, blocks: [Bash] }        → 串行（单独）
  Batch 3: { isConcurrencySafe: true,  blocks: [Read] }        → 可以并发，但只有一个
  Batch 4: { isConcurrencySafe: false, blocks: [Edit] }        → 串行（写操作）
```

批次之间是**串行**的——Batch 1 全部完成才开始 Batch 2，以此类推。批次内部才是并发的。

---

## isConcurrencySafe：工具自己声明安全性

`isConcurrencySafe` 是工具的一个方法，由每个工具自己实现。典型情况：

- **Read**：`isConcurrencySafe = true`——只读，并发安全
- **Glob、Grep**：`isConcurrencySafe = true`——只读文件系统，并发安全
- **Edit、Write**：`isConcurrencySafe = false`——修改文件，必须串行
- **Bash**：`isConcurrencySafe = false`——可能有任意副作用，必须串行

这是一个**权能声明（capability declaration）**模式：工具自己知道自己是否并发安全，系统信任这个声明。比起系统外部猜测哪些工具安全，由工具自己声明更准确，也更容易维护。

---

## runTools()：按批执行

**文件：[src/services/tools/toolOrchestration.ts](../src/services/tools/toolOrchestration.ts#L19-L82)**

```typescript
export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext
  
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(...)) {
    if (isConcurrencySafe) {
      // 并发批次
      for await (const update of runToolsConcurrently(blocks, ...)) {
        // 收集 context modifier，不立即应用（避免并发修改）
        yield { message: update.message, newContext: currentContext }
      }
      // 并发批次结束后，按序应用所有 context modifier
      for (const block of blocks) {
        const modifiers = queuedContextModifiers[block.id]
        for (const modifier of modifiers) {
          currentContext = modifier(currentContext)
        }
      }
    } else {
      // 串行批次
      for await (const update of runToolsSerially(blocks, ...)) {
        if (update.newContext) {
          currentContext = update.newContext  // 立即应用
        }
        yield { message: update.message, newContext: currentContext }
      }
    }
  }
}
```

注意**并发批次的 context 更新机制**：并发工具各自产生 `contextModifier`（一个修改 `ToolUseContext` 的函数），但这些修改**被排队**，直到整个并发批次结束后，按原始顺序依次应用。这避免了并发工具互相干扰 context。

---

## runToolsConcurrently()：并发执行

**文件：[src/services/tools/toolOrchestration.ts](../src/services/tools/toolOrchestration.ts#L152-L177)**

```typescript
async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  ...
): AsyncGenerator<MessageUpdateLazy, void> {
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      yield* runToolUse(toolUse, ...)
    }),
    getMaxToolUseConcurrency(),  // 默认 10，可通过环境变量覆盖
  )
}
```

`all()` 是一个并发 AsyncGenerator 合并器：接受多个 AsyncGenerator，同时运行它们，当任意一个有新值时立即 yield，直到所有都完成。最大并发度默认是 10（`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`）。

---

## runToolsSerially()：串行执行

**文件：[src/services/tools/toolOrchestration.ts](../src/services/tools/toolOrchestration.ts#L118-L150)**

```typescript
async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  ...
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext
  
  for (const toolUse of toolUseMessages) {
    toolUseContext.setInProgressToolUseIDs(prev => new Set(prev).add(toolUse.id))
    
    for await (const update of runToolUse(toolUse, ...)) {
      if (update.contextModifier) {
        currentContext = update.contextModifier.modifyContext(currentContext)
      }
      yield { message: update.message, newContext: currentContext }
    }
    
    markToolUseAsComplete(toolUseContext, toolUse.id)
  }
}
```

串行很直接：一个工具完成（`runToolUse` generator 结束），才开始下一个。每个工具的 `contextModifier` 立即应用。

---

## setInProgressToolUseIDs：UI 进度追踪

每个工具开始执行时：
```typescript
toolUseContext.setInProgressToolUseIDs(prev => new Set(prev).add(toolUse.id))
```

执行完成时：
```typescript
markToolUseAsComplete(toolUseContext, toolUse.id) // 删除 toolUse.id
```

这个 `Set<string>` 被 TUI 用来显示"正在执行"状态——当某个工具的 id 在这个 Set 里，该工具在 UI 里显示 spinner；从 Set 里移除后，UI 显示完成状态。

---

## runToolUse()：单个工具的执行

`runToolUse()` 是 `checkPermissionsAndCallTool()` 的直接调用者（在 7-4 节讲过）。流程：

```
runToolUse(toolUse, assistantMessage, canUseTool, context)
    ↓
checkPermissionsAndCallTool()
    ↓
  1. Zod Schema 验证 input
  2. speculative classifier 启动（并行）
  3. Pre-tool-use hooks 执行
  4. 权限检查（canUseTool）
  5. tool.call() 执行
  6. Post-tool-use hooks
    ↓
yield progress messages
yield final result message (type: 'user', content: [{ type: 'tool_result', ... }])
```

---

## 完整执行时序图

```
queryLoop() 收到 needsFollowUp=true
    │
    └─ runTools(toolUseBlocks, ...)
              │
              ├─ partitionToolCalls()
              │   [Read, Read, Bash, Edit]
              │         ↓
              │   Batch[0]: concurrent [Read, Read]
              │   Batch[1]: serial    [Bash]
              │   Batch[2]: serial    [Edit]
              │
              ├─ Batch[0]: runToolsConcurrently([Read, Read])
              │   ├─ goroutine A: runToolUse(Read "file1")
              │   └─ goroutine B: runToolUse(Read "file2")
              │   (并发执行，谁先完成谁先 yield)
              │
              ├─ Batch[1]: runToolsSerially([Bash])
              │   └─ runToolUse(Bash "ls src/")
              │
              └─ Batch[2]: runToolsSerially([Edit])
                  └─ runToolUse(Edit "src/main.ts")
```

---

## 本节小结

- `partitionToolCalls()` 把工具列表分成串行/并发批次：连续的"并发安全"工具合并为一批，其余单独成批
- 并发安全性由工具自己声明（`isConcurrencySafe()`），读操作安全，写操作不安全
- 并发批次的 `ToolUseContext` 更新被排队，批次结束后按序应用，避免并发修改
- 最大并发度默认 10，可通过 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 覆盖
- `setInProgressToolUseIDs` 追踪正在执行的工具 ID，驱动 UI 进度显示

## 前后呼应

- 本节 `runToolUse()` 最终调用的 `checkPermissionsAndCallTool()` 在 **[7-4 节](./7-4-工具的执行call生命周期.md)** 有完整讲解
- 本节的结果（`toolResults`）将在下一节看到它如何变成下一次 API 调用的输入

## 下一节预告

工具执行完了，结果怎么"喂回"给 Claude？为什么工具结果要作为 user message 而不是 assistant message 发送？

➡️ [下一节：9-7 工具结果如何"喂回"给 Claude](./9-7-工具结果如何喂回给Claude.md)
