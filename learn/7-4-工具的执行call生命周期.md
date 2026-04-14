# 7-4 工具的执行：call() 的生命周期

> **本节目标**：Claude 发来 `tool_use` 请求，`call()` 被调用，然后什么？这节课追踪一个工具从"Claude 请求调用"到"结果返回给 Claude"的完整路径——包括并发决策、权限检查、错误处理，以及工具结果为什么也是 AsyncGenerator。

---

## 从工具调用请求到 call()

Claude 在流式响应里发来这样的 JSON 块：

```json
{
  "type": "tool_use",
  "id": "toolu_01abc",
  "name": "Read",
  "input": { "file_path": "src/main.tsx" }
}
```

这个请求最终走到 `toolOrchestration.ts` 里的 `runTools()`。

---

## 并发决策：读写分离的批次

**文件：[src/services/tools/toolOrchestration.ts](../src/services/tools/toolOrchestration.ts#L19-L82)**

`runTools()` 收到的不是单个工具调用，而是一批：Claude 一次 API 响应里可能同时请求调用多个工具。

```typescript
export async function* runTools(
  toolUseMessages: ToolUseBlock[],  // 这一轮的所有工具调用请求
  // ...
): AsyncGenerator<MessageUpdate, void> {
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(...)) {
    if (isConcurrencySafe) {
      yield* runToolsConcurrently(blocks, ...)  // 并行
    } else {
      yield* runToolsSerially(blocks, ...)      // 串行
    }
  }
}
```

关键在 `partitionToolCalls()`：

**文件：[src/services/tools/toolOrchestration.ts](../src/services/tools/toolOrchestration.ts#L91-L116)**

```typescript
function partitionToolCalls(toolUseMessages, toolUseContext): Batch[] {
  return toolUseMessages.reduce((acc, toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const isConcurrencySafe = tool?.isConcurrencySafe(parsedInput.data) ?? false
    
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      // 上一批也是并发安全的，合并进同一批
      acc[acc.length - 1].blocks.push(toolUse)
    } else {
      // 新开一批
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}
```

这段代码把工具调用列表分成批次，规则是：**连续的并发安全工具合并成一个并发批次，非安全工具单独一批串行执行**。

一个实际例子：Claude 同时请求 `[Read(a), Read(b), Bash("ls"), Read(c)]`：

```
输入：[Read(a), Read(b), Bash("ls"), Read(c)]

分析：
- Read(a): isConcurrencySafe = true  → 批次 1
- Read(b): isConcurrencySafe = true  → 合并进批次 1
- Bash("ls"): isConcurrencySafe = true，但前面是并发批次，合并？
  → 实际上 Bash 的 isConcurrencySafe 也返回 true
  → 合并进批次 1
- Read(c): isConcurrencySafe = true  → 合并进批次 1

分批结果：[{isConcurrencySafe: true, blocks: [Read(a), Read(b), Bash("ls"), Read(c)]}]
→ 全部并发执行
```

如果 Claude 请求 `[Read(a), Write(b), Read(c)]`：

```
- Read(a): isConcurrencySafe = true  → 批次 1
- Write(b): isConcurrencySafe = false → 批次 2（Write 不是并发安全的）
- Read(c): isConcurrencySafe = true  → 批次 3（Write 打断了并发链）

分批结果：
  批次 1: [Read(a)]     → 并发（只有一个，但仍然是并发批次）
  批次 2: [Write(b)]    → 串行
  批次 3: [Read(c)]     → 并发（只有一个）
→ 串行执行三个批次
```

---

## runToolUse()：单个工具的执行

**文件：[src/services/tools/toolExecution.ts](../src/services/tools/toolExecution.ts#L337-L410)**

每个工具调用最终走到 `runToolUse()`：

```typescript
export async function* runToolUse(
  toolUse: ToolUseBlock,      // Claude 的工具调用请求
  assistantMessage,           // 包含这个工具调用的 assistant 消息
  canUseTool: CanUseToolFn,   // 权限检查函数
  toolUseContext,             // 执行环境
): AsyncGenerator<MessageUpdateLazy, void> {
  
  // 1. 找到工具
  let tool = findToolByName(toolUseContext.options.tools, toolUse.name)
  
  // 兼容：旧名字（别名）的工具仍然能执行
  if (!tool) {
    const fallbackTool = findToolByName(getAllBaseTools(), toolUse.name)
    if (fallbackTool?.aliases?.includes(toolUse.name)) {
      tool = fallbackTool  // 被重命名的工具，通过别名找到
    }
  }
  
  // 2. 工具不存在：返回错误 tool_result
  if (!tool) {
    yield { message: createUserMessage({ content: [{
      type: 'tool_result',
      content: `Error: No such tool: ${toolUse.name}`,
      is_error: true,
      tool_use_id: toolUse.id,
    }] }) }
    return
  }
  
  // 3. 检查是否已被取消（Ctrl+C）
  if (toolUseContext.abortController.signal.aborted) {
    yield { message: createUserMessage({ content: [createToolResultStopMessage(toolUse.id)] }) }
    return
  }
  
  // 4. 进入权限检查 + 执行的核心流程
  yield* streamedCheckPermissionsAndCallTool(tool, toolUse.id, toolInput, ...)
}
```

### 为什么 runToolUse 是 AsyncGenerator？

工具执行期间可能产生**多个事件**：
- `yield { message: progressMessage }` → 工具执行进度（比如 Bash 命令的实时输出）
- `yield { message: resultMessage }` → 最终的 tool_result

`query.ts` 里的 `queryLoop` 会消费这些 yield 出来的消息，把进度消息显示在 TUI，把 result 消息加入对话历史发回给 Claude。

---

## streamedCheckPermissionsAndCallTool()：权限检查 + 执行

这是最核心的函数，完整流程如下：

```
1. Schema 验证（Zod）
        ↓
2. checkPermissions()（工具自定义的权限检查，如 Bash 的命令白名单）
        ↓
3. 运行 PreToolUseHooks（用户配置的 hooks）
        ↓
4. canUseTool()（权限模式检查：是否需要用户确认）
        ↓
5. 显示权限对话框（如果需要用户确认）
        ↓
6. 用户批准/拒绝
        ↓  批准
7. tool.call(validatedInput, context, canUseTool, parentMessage)
        ↓
8. 运行 PostToolUseHooks
        ↓
9. 格式化并 yield tool_result
```

关键步骤是权限检查（步骤 4-6），下一章会详细讲。这里关注步骤 7 的 `tool.call()`。

---

## tool.call() 的签名

**文件：[src/Tool.ts](../src/Tool.ts#L379-L385)**

```typescript
call(
  args: z.infer<Input>,           // 经过 Schema 验证的参数（有正确的 TypeScript 类型）
  context: ToolUseContext,         // 执行环境
  canUseTool: CanUseToolFn,        // 权限检查函数（工具内部可以用它做嵌套权限检查）
  parentMessage: AssistantMessage, // 哪条 assistant 消息触发了这次工具调用
  onProgress?: ToolCallProgress,   // 进度回调（工具可以用它发送中间进度）
): Promise<ToolResult<Output>>
```

注意 `args` 已经是 `z.infer<Input>` 类型——Zod 验证在调用 `call()` 之前已经完成，不需要在 `call()` 里再验证。

### 工具结果的格式

`tool.call()` 返回 `ToolResult<Output>`：

```typescript
type ToolResult<T> = {
  type: 'result'
  resultForAssistant: ContentBlockParam[]  // 发给 Claude 的内容
  output: T                                // 类型化输出（用于内部处理）
  isError?: boolean
}
```

`resultForAssistant` 是最终构建 `tool_result` 消息的内容。它可以是文字，也可以是图片（如截图工具）。

---

## BashTool.call() 的实际执行

BashTool 的 `call()` 里大概做这些事：

```typescript
async call(input: BashToolInput, context, canUseTool) {
  const { command, timeout, run_in_background } = input
  
  // 1. 创建 progress 消息（让 TUI 显示"正在执行..."）
  context.setAppState(prev => ({
    ...prev,
    streamMode: 'tool-use',  // 告诉 TUI 切换到工具执行模式
  }))
  
  // 2. 创建子进程执行命令
  const process = spawn(command, { shell: true, timeout })
  
  // 3. 流式读取输出
  let stdout = ''
  let stderr = ''
  
  process.stdout.on('data', chunk => {
    stdout += chunk
    // 发送进度更新
    onProgress?.({ stdout, stderr, interrupted: false })
  })
  
  // 4. 等待完成
  const exitCode = await waitForProcess(process)
  
  // 5. 返回结果
  return {
    type: 'result',
    output: { stdout, stderr, interrupted: false },
    resultForAssistant: [{ type: 'text', text: formatBashOutput(stdout, stderr, exitCode) }],
  }
}
```

工具执行是完全在 Claude Code 进程里发生的——不是远程调用，就是本地执行。

---

## 工具执行结果的大小限制

`maxResultSizeChars: 30_000` 定义了 BashTool 的结果大小上限。

如果命令输出超过 30K 字符，发生什么？

**文件：[src/utils/toolResultStorage.ts](../src/utils/toolResultStorage.ts)**

```typescript
// 超出上限的结果：持久化到磁盘，Claude 拿到文件路径
if (resultSize > tool.maxResultSizeChars) {
  const filePath = await saveToolResultToDisk(result)
  return createUserMessage({
    content: [{
      type: 'tool_result',
      content: `Result too large (${resultSize} chars). Full output saved to: ${filePath}
Preview: ${result.slice(0, 500)}...`,
      tool_use_id: toolUse.id,
    }]
  })
}
```

Claude 会收到一个截断的预览和文件路径，可以用 `Read` 工具读取完整内容。

这个设计避免了超大输出塞满上下文窗口——但 Claude 仍然能访问到完整内容（通过 Read 工具）。

---

## 本节小结

- `partitionToolCalls()` 按 `isConcurrencySafe` 把工具调用分批，连续安全的工具并发执行
- `runToolUse()` 是单个工具调用的入口：查工具、检查取消、进权限检查流程
- `tool.call()` 接收 Zod 验证后的参数（已有正确 TypeScript 类型），返回 `ToolResult`
- 工具执行结果超出 `maxResultSizeChars` 时自动持久化到磁盘，Claude 拿到文件路径
- 整个执行链是 AsyncGenerator，支持流式进度更新

## 前后呼应

- 本节的并发决策（`isConcurrencySafe`），在 **[9-6 节](./9-6-并发工具执行Promise-all策略.md)** 会看到它在 queryLoop 里的使用
- 本节的权限检查步骤（`canUseTool`），**[第 11 章](./11-1-权限系统的设计动机.md)** 会完整拆解

## 下一节预告

工具执行了，但执行之前有个权限检查的步骤被我们跳过了。`checkPermissions()` 和 `canUseTool()` 是什么关系？Bash 是怎么判断一个命令是否危险的？

➡️ [下一节：7-5 权限检查：工具执行前的守门人](./7-5-权限检查工具执行前的守门人.md)
