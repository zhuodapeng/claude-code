# 7-3 工具注册表：assembleToolPool 的工作

> **本节目标**：Claude Code 有 40+ 个内置工具，还有 MCP 插件提供的工具。每次 API 请求需要把工具列表发给 Claude。但不是所有工具都应该每次都发——有些工具在某些条件下不启用，有些被用户禁用，有些只在特定模式下出现。`assembleToolPool()` 就是做这个决策的地方。

---

## 为什么需要"组装"工具池

直觉上，工具列表应该是固定的：有哪些工具，就发哪些工具。

但 Claude Code 里工具列表是**动态的**：

1. **环境差异**：Windows 有 `PowerShell` 工具，Mac/Linux 没有
2. **模式差异**：`--bare` 简化模式只有 3 个工具（Bash、Read、Edit）
3. **权限差异**：用户配置了 `--disallowedTools Edit`，就不能有 `Edit`
4. **功能开关**：某些工具只在 `feature()` flag 开启时存在（死代码消除）
5. **MCP 插件**：用户安装的 MCP 服务器提供额外工具
6. **`isEnabled()`**：某些工具在运行时动态决定是否启用

---

## 工具池组装的流程

```
getAllBaseTools()
    ↓  完整的工具数组（含所有内置工具）

getTools(permissionContext)
    ↓  过滤：
       - 简化模式（CLAUDE_CODE_SIMPLE）只保留 3 个
       - 过滤 deny rules（用户禁用的工具）
       - 过滤 isEnabled() 返回 false 的工具
       - REPL 模式下隐藏原始工具（Bash/Read/Edit）

assembleToolPool(permissionContext, mcpTools)
    ↓  合并 + 去重：
       - 内置工具（已过滤）
       - MCP 工具（过滤 deny rules）
       - 按名字排序（稳定缓存键）
       - uniqBy 去重（内置工具优先）
```

---

## `getAllBaseTools()`：所有工具的源头

**文件：[src/tools.ts](../src/tools.ts#L193-L251)**

```typescript
export function getAllBaseTools(): Tools {
  return [
    AgentTool,           // 子 Agent 工具
    TaskOutputTool,      // 任务输出
    BashTool,            // Shell 执行
    
    // 如果二进制里内嵌了 bfs/ugrep，就不需要独立的 Glob/Grep 工具
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    // ...
    
    // 条件性工具：只在特定环境/配置下存在
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    ...(isAgentSwarmsEnabled() ? [TeamCreateTool, TeamDeleteTool] : []),
    
    // feature() 门控：打包时死代码消除
    ...(SleepTool ? [SleepTool] : []),
    ...cronTools,
    
    // 测试工具：只在测试环境存在
    ...(process.env.NODE_ENV === 'test' ? [TestingPermissionTool] : []),
    
    // ToolSearch 工具：当工具数量超过阈值时启用
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
  ]
}
```

注释里有个关键提醒：`This MUST stay in sync with ...statsig.com/...`——这个列表决定了 System Prompt 的哈希，用于 Prompt Cache。如果这个列表改变，缓存就失效了（更贵）。

### `feature()` 门控 vs 运行时条件

代码里混用了两种条件：

```typescript
// 方式 1：feature() - 构建时死代码消除
const SleepTool = feature('PROACTIVE') ? require('./SleepTool.js').SleepTool : null
...(SleepTool ? [SleepTool] : [])

// 方式 2：运行时判断
...(isWorktreeModeEnabled() ? [EnterWorktreeTool] : [])
```

`feature()` 是 Bun 的构建时特性——在打包时，`feature('PROACTIVE')` 如果是 false，整个 import 语句都被删掉，代码里根本不存在这个工具。对外发布的版本里，内部工具完全不存在。

运行时判断则是：工具的代码在二进制里，但根据当前配置决定是否加入列表。

---

## `getTools()`：内置工具的过滤

**文件：[src/tools.ts](../src/tools.ts#L271-L327)**

```typescript
export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  
  // 简化模式：只有最基础的工具
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }
  
  // 正常模式：从完整列表开始
  const tools = getAllBaseTools().filter(
    tool => !specialTools.has(tool.name)  // 排除总是单独处理的特殊工具
  )
  
  // 应用 deny rules（用户配置的黑名单）
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)
  
  // REPL 模式：隐藏原始工具（它们通过 REPL VM 暴露）
  if (isReplModeEnabled()) {
    const replEnabled = allowedTools.some(t => toolMatchesName(t, REPL_TOOL_NAME))
    if (replEnabled) {
      allowedTools = allowedTools.filter(t => !REPL_ONLY_TOOLS.has(t.name))
    }
  }
  
  // 最后：过滤 isEnabled() 返回 false 的工具
  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}
```

注意 `isEnabled()` 是最后才调用的——它可能做动态判断（比如检查账户状态），所以放最后。

---

## `assembleToolPool()`：合并内置工具和 MCP 工具

**文件：[src/tools.ts](../src/tools.ts#L345-L367)**

```typescript
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  // 1. 获取过滤后的内置工具
  const builtInTools = getTools(permissionContext)
  
  // 2. 过滤 MCP 工具（也要遵守 deny rules）
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)
  
  // 3. 按名排序，保证缓存稳定性
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  
  // 4. 内置工具在前，MCP 工具在后，去重（内置优先）
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}
```

### 排序是为了缓存稳定性

注释解释了为什么要排序：

> Sort each partition for prompt-cache stability, keeping built-ins as a contiguous prefix. The server's cache policy places a cache breakpoint after the last built-in tool; a flat sort would interleave MCP tools into built-ins and invalidate all downstream cache keys whenever an MCP tool sorts between existing built-ins.

Anthropic 服务端对工具列表做 Prompt Cache。内置工具列表相对稳定，服务端在"最后一个内置工具"后面打了一个缓存分割点。

如果按字母排序后 MCP 工具插入到内置工具中间，缓存分割点就会失效——每次添加 MCP 工具都会让所有工具之后的内容（System Prompt 的后半部分）重新计算，增加 token 费用。

保持内置工具作为一个连续的前缀，就能让 Prompt Cache 更稳定。

---

## 工具池和 API 请求的关系

组装好的工具池，还需要**转换成 Anthropic API 接受的格式**才能发出去。

这个转换发生在 `src/services/api/claude.ts` 的 `queryModelWithStreaming()` 里：

```typescript
// 简化版
function toolsToApiFormat(tools: Tools): ApiToolDefinition[] {
  return tools.map(tool => ({
    name: tool.name,
    description: await tool.description(input, options),
    input_schema: tool.inputJSONSchema || zodToJsonSchema(tool.inputSchema),
  }))
}
```

每个工具的 Zod Schema 被转换成 JSON Schema，和工具名称、动态描述一起，发给 Claude 作为可用工具列表。

---

## 工具数量的问题：ToolSearch

40+ 个工具直接发给 Claude 会消耗大量 token（工具定义本身也要算 token）。

当工具数量超过某个阈值，Claude Code 会启用 **ToolSearch 机制**：

1. 大部分工具标记为 `shouldDefer: true`，不直接发完整定义，只发名称和 `searchHint`
2. Claude 如果需要用某个工具，先用 `ToolSearch` 工具搜索
3. `ToolSearch` 返回匹配工具的完整 schema
4. Claude 然后调用那个工具

这是一个"懒加载"机制——需要时才加载完整定义，节省 token。

**文件：[src/tools.ts](../src/tools.ts#L247-L250)**

```typescript
// getAllBaseTools() 里的最后几行：
...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
```

`isToolSearchEnabledOptimistic()` 做的是乐观检查——如果工具数量可能超过阈值，就预先把 `ToolSearchTool` 加进来。实际是否启用 defer 机制，在发 API 请求时才决定。

---

## 本节小结

- `getAllBaseTools()` 是完整工具列表的源头，混合了静态导入和条件导入
- `getTools()` 在运行时过滤：简化模式、deny rules、`isEnabled()`
- `assembleToolPool()` 合并内置工具和 MCP 工具，按名排序保证 Prompt Cache 稳定
- 工具按名排序后内置工具在前是刻意设计——服务端缓存在内置工具后面打断点
- 工具数量超阈值时，ToolSearch 机制懒加载工具定义，节省 token

## 前后呼应

- 本节的 `filterToolsByDenyRules()`，在 **[11-2 节](./11-2-权限规则的数据结构.md)** 会看到 deny rules 的完整格式
- 本节的 ToolSearch 机制，在 **[7-7 节](./7-7-ToolSearch懒加载机制.md)** 会深入讲解

## 下一节预告

工具池组装好了。工具的 `call()` 方法被调用时，实际发生了什么？谁负责协调多个工具的执行？并发是怎么处理的？

➡️ [下一节：7-4 工具的执行：call() 的生命周期](./7-4-工具的执行call生命周期.md)
