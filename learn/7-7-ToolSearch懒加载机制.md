# 7-7 ToolSearch：工具定义的懒加载

> **本节目标**：Claude Code 有 40+ 个内置工具 + 用户安装的 MCP 工具，总数可能超过 100 个。如果把所有工具的完整定义（名称 + 描述 + JSON Schema）都塞进每次 API 请求，会消耗大量 token。ToolSearch 机制怎么解决这个问题？"延迟加载"工具定义是什么意思？

---

## 问题：工具定义本身就是 token 负担

工具定义不是免费的。每个工具的 JSON Schema 都要算 token：

```json
{
  "name": "Edit",
  "description": "Performs exact string replacements in files...\n\nUsage:\n- You must use your `Read` tool...",
  "input_schema": {
    "type": "object",
    "properties": {
      "file_path": { "type": "string", "description": "The absolute path..." },
      "old_string": { "type": "string", "description": "The text to replace..." },
      ...
    }
  }
}
```

一个工具定义大概 200-500 token。100 个工具 = 20,000-50,000 token。

这带来两个问题：

1. **成本**：每次 API 请求都要发这些 token，不管 Claude 实际用没用这些工具
2. **Prompt Cache 命中率**：工具列表越大，越可能有工具被增删改（MCP 工具尤其如此），导致缓存失效

### MCP 工具是问题的核心

内置工具（Read、Write、Bash 等）相对稳定，变化少，缓存命中率高。

MCP 工具则完全不同：

- 用户可能安装了几十个 MCP 服务器
- 每个服务器提供几十个工具（Slack、GitHub、数据库操作...）
- 这些工具大多数在一个具体任务里用不到

---

## 解法：延迟加载（Deferred Loading）

### 核心思想

不是把所有工具的完整 Schema 都发给 Claude，而是：

1. 只发"工具名称列表"（告诉 Claude 有哪些工具可用）
2. Claude 需要用某个工具时，先调用 `ToolSearch` 工具来"加载"它的完整定义
3. `ToolSearch` 返回那个工具的完整 Schema
4. Claude 现在有了 Schema，可以正确调用这个工具

```
传统方案（全量发送）：
  API 请求 → [Read Schema][Write Schema][Edit Schema][mcp__slack__send_message Schema]...(100个)
  ↓
  Claude 直接调用任何工具

延迟加载方案：
  API 请求 → [Read Schema][Write Schema]...(核心工具) + [mcp__slack__send_message][mcp__github__*]...(只有名称)
  ↓
  Claude 发现需要 mcp__slack__send_message
  ↓
  Claude 调用 ToolSearch(query: "select:mcp__slack__send_message")
  ↓
  ToolSearch 返回 mcp__slack__send_message 的完整 Schema
  ↓
  Claude 调用 mcp__slack__send_message(...)
```

---

## isDeferredTool()：哪些工具要被延迟加载？

**文件：[src/tools/ToolSearchTool/prompt.ts](../src/tools/ToolSearchTool/prompt.ts#L62-L108)**

```typescript
export function isDeferredTool(tool: Tool): boolean {
  // 1. 如果工具显式声明 alwaysLoad，永远不延迟
  if (tool.alwaysLoad === true) return false
  
  // 2. MCP 工具默认总是延迟加载（workflow-specific）
  if (tool.isMcp === true) return true
  
  // 3. ToolSearch 本身永远不延迟——模型需要它来加载其他工具
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false
  
  // 4. AgentTool 在特定实验模式下不延迟
  if (feature('FORK_SUBAGENT') && tool.name === AGENT_TOOL_NAME) {
    if (isForkSubagentEnabled()) return false
  }
  
  // 5. 其他工具：看 shouldDefer 字段
  return tool.shouldDefer === true
}
```

分类总结：

| 工具类型 | 是否延迟 | 原因 |
|---------|---------|------|
| 内置核心工具（Read/Write/Edit/Bash...） | 否 | 高频使用，延迟会增加往返次数 |
| MCP 工具 | 是（默认） | 场景特定，大多数任务用不到 |
| ToolSearch 本身 | 否 | 必须立即可用，否则无法加载其他工具 |
| `shouldDefer: true` 的工具 | 是 | 工具作者主动声明"我是低频工具" |

---

## isToolSearchEnabled()：什么时候启用这个机制？

**文件：[src/utils/toolSearch.ts](../src/utils/toolSearch.ts#L155-L198)**

ToolSearch 有三种模式（由 `ENABLE_TOOL_SEARCH` 环境变量控制）：

```typescript
type ToolSearchMode = 
  | 'tst'         // 总是启用：延迟 MCP 工具和 shouldDefer 工具
  | 'tst-auto'    // 自动：只有工具 token 超过阈值时才延迟
  | 'standard'    // 关闭：所有工具全量发送

// 默认值（不设环境变量）：'tst'
// → 默认总是延迟 MCP 工具
```

`tst-auto` 模式下的阈值计算：

```typescript
// 阈值 = 上下文窗口的 10%（默认）
// 例如：claude-opus-4-6 的上下文窗口 = 200K token
// → 阈值 = 20,000 token

if (deferredToolTokens >= threshold) {
  // MCP 工具太多 → 启用延迟加载
  return { enabled: true }
}
```

---

## ToolSearch 工具本身的实现

**文件：[src/tools/ToolSearchTool/ToolSearchTool.ts](../src/tools/ToolSearchTool/ToolSearchTool.ts#L304-L471)**

```typescript
export const ToolSearchTool = buildTool({
  name: 'ToolSearch',
  
  async call(input, { options: { tools } }) {
    const { query, max_results = 5 } = input
    
    // 只在延迟工具里搜索
    const deferredTools = tools.filter(isDeferredTool)
    
    // 支持两种查询方式：
    
    // 方式 1：精确选择（select: 前缀）
    const selectMatch = query.match(/^select:(.+)$/i)
    if (selectMatch) {
      // "select:Read,Edit" → 直接返回这几个工具的 Schema
      const names = selectMatch[1].split(',').map(s => s.trim())
      const found = names.map(name => findToolByName(deferredTools, name))
      return buildSearchResult(found.map(t => t.name), ...)
    }
    
    // 方式 2：关键词搜索
    // "slack message" → 在工具名称和描述里搜索
    const matches = await searchToolsWithKeywords(query, deferredTools, tools, max_results)
    return buildSearchResult(matches, ...)
  },
  
  // 关键：返回的不是普通文本，而是 tool_reference 内容块
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: content.matches.map(name => ({
        type: 'tool_reference',  // ← 特殊类型！
        tool_name: name,
      })),
    }
  }
})
```

### tool_reference：API 的特殊响应格式

注意 `type: 'tool_reference'`——这不是普通文本，是 Anthropic API 的特殊内容块类型。

当 API 收到 `tool_reference` 时，它会自动把对应工具的完整 Schema 注入进对话上下文里。也就是说，**工具定义的展开发生在服务端**，不需要客户端再发一轮完整的 Schema。

这是一个精妙的设计：客户端告诉服务端"我需要这几个工具的定义"，服务端把它们插入进去，Claude 就能看到并使用这些工具的完整 Schema，而无需额外的往返请求。

---

## 关键词搜索的评分算法

**文件：[src/tools/ToolSearchTool/ToolSearchTool.ts](../src/tools/ToolSearchTool/ToolSearchTool.ts#L186-L302)**

当 Claude 不知道确切工具名时，用关键词搜索：

```typescript
async function searchToolsWithKeywords(
  query: string,        // "slack message"
  deferredTools: Tools,
  tools: Tools,
  maxResults: number,
): Promise<string[]> {
  // 快速路径：精确匹配工具名
  const exactMatch = deferredTools.find(t => t.name.toLowerCase() === queryLower)
  if (exactMatch) return [exactMatch.name]
  
  // 对每个工具打分
  const scored = await Promise.all(deferredTools.map(async tool => {
    const parsed = parseToolName(tool.name)
    // 获取工具描述（memoized，只获取一次）
    const description = await getToolDescriptionMemoized(tool.name, tools)
    
    let score = 0
    for (const term of queryTerms) {
      // 工具名精确包含 → 高分（10/12分）
      if (parsed.parts.includes(term)) score += 10
      // 工具名部分匹配 → 中分（5/6分）
      else if (parsed.parts.some(p => p.includes(term))) score += 5
      // searchHint 匹配 → 4分（工具作者提供的搜索线索）
      if (hintNormalized && pattern.test(hintNormalized)) score += 4
      // 描述里匹配 → 2分
      if (pattern.test(descNormalized)) score += 2
    }
    return { name: tool.name, score }
  }))
  
  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)  // 高分在前
    .slice(0, maxResults)
    .map(item => item.name)
}
```

### MCP 工具名的解析

MCP 工具有特殊命名格式：`mcp__serverName__toolName`

```typescript
function parseToolName(name: string): { parts: string[], isMcp: boolean } {
  if (name.startsWith('mcp__')) {
    // mcp__claude_ai_Slack__send_message → ["claude", "ai", "slack", "send", "message"]
    const withoutPrefix = name.replace(/^mcp__/, '').toLowerCase()
    const parts = withoutPrefix.split('__').flatMap(p => p.split('_'))
    return { parts: parts.filter(Boolean), isMcp: true }
  }
  
  // CamelCase 工具名 → WriteFile → ["write", "file"]
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // WriteFile → "Write File"
    .toLowerCase()
    .split(/\s+/)
  return { parts, isMcp: false }
}
```

搜索 "slack message" 时：

```
工具：mcp__claude_ai_Slack__send_message
解析：["claude", "ai", "slack", "send", "message"]
搜索词：["slack", "message"]
  "slack" → 在 parts 里精确匹配 → +12分（MCP 工具 bonus）
  "message" → 在 parts 里精确匹配 → +12分
总分：24 → 排名第一
```

### searchHint 字段的作用

每个工具可以设置 `searchHint`：

```typescript
// BashTool
export const BashTool = buildTool({
  searchHint: 'execute shell commands',  // ← 搜索线索
  ...
})
```

`searchHint` 是工具作者为搜索准备的"关键词提示"，权重比完整描述（2分）高（4分）。

这允许工具作者主动暴露更精准的搜索词——比如一个"文件比对"工具可能叫 `DiffTool`，但 `searchHint: 'compare files difference changes'` 让它在搜索 "file diff" 或 "compare changes" 时也能被找到。

---

## 完整的延迟加载工作流

把所有部分串起来：

```
1. API 请求发出
   ├─ 核心工具（Read/Write/Edit/Bash）：完整 Schema 发出
   └─ 延迟工具（MCP 工具、shouldDefer 工具）：
         仅发名称，标记 defer_loading: true
         （通过 system-reminder 消息告知 Claude 有哪些延迟工具）
         
2. Claude 看到任务："发一条 Slack 消息"
   ├─ Claude 知道有 mcp__slack__send_message（从工具名称列表里）
   ├─ 但没有它的完整 Schema（参数格式不知道）
   └─ Claude 先调用：
        ToolSearch(query: "select:mcp__slack__send_message")
   
3. ToolSearch 工具执行
   └─ 返回：
        content: [{ type: "tool_reference", tool_name: "mcp__slack__send_message" }]
   
4. API 服务端处理 tool_reference
   └─ 自动把 mcp__slack__send_message 的完整 Schema 注入对话上下文
   
5. Claude 现在有了完整 Schema，调用：
   mcp__slack__send_message(channel: "#general", text: "Hello!")
   
6. 工具执行，返回结果
```

---

## 描述缓存：避免重复获取工具描述

**文件：[src/tools/ToolSearchTool/ToolSearchTool.ts](../src/tools/ToolSearchTool/ToolSearchTool.ts#L66-L100)**

搜索算法需要工具描述来做关键词匹配。但每次获取描述（尤其是 MCP 工具描述）可能需要网络请求，成本高。

```typescript
// memoize by tool name: 同一个工具的描述只获取一次
const getToolDescriptionMemoized = memoize(
  async (toolName: string, tools: Tools): Promise<string> => {
    const tool = findToolByName(tools, toolName)
    return tool?.prompt({ ... }) ?? ''
  },
  (toolName: string) => toolName,  // ← 缓存键是工具名
)

// 当延迟工具集合变化时（MCP 服务器连接/断开），缓存失效
function maybeInvalidateCache(deferredTools: Tools): void {
  const currentKey = getDeferredToolsCacheKey(deferredTools)
  if (cachedDeferredToolNames !== currentKey) {
    getToolDescriptionMemoized.cache.clear?.()
    cachedDeferredToolNames = currentKey
  }
}
```

这是"基于变化检测的缓存失效"——不是定时失效，而是在"工具集合发生变化"时失效。

---

## 为什么 ToolSearch 不能被延迟加载自己？

一个有趣的自引用问题：ToolSearch 是用来加载其他工具的，但它本身也是工具——能被延迟加载吗？

答案是：不能。代码里明确处理了这个情况：

```typescript
// isDeferredTool() 里：
if (tool.name === TOOL_SEARCH_TOOL_NAME) return false  // ← 永远不延迟
```

**原因**：如果 ToolSearch 本身被延迟加载了，Claude 需要"某个工具"来加载 ToolSearch……而那个工具还没被加载……这是死锁。

ToolSearch 必须作为"基础设施工具"在第一次 API 请求时就发出完整定义，这样 Claude 才能用它来加载所有其他延迟工具。

---

## 本节小结

- ToolSearch 解决了"工具定义太多 → token 成本高"的问题，通过按需加载工具 Schema
- `isDeferredTool()` 决定哪些工具延迟：MCP 工具默认延迟，内置核心工具不延迟，ToolSearch 自己永远不延迟
- 延迟工具只发名称，需要时先调用 `ToolSearch(query: "select:toolName")` 来加载完整 Schema
- `tool_reference` 是 Anthropic API 的特殊类型，让服务端直接把工具 Schema 注入对话上下文，避免额外往返
- 搜索评分考虑：工具名匹配（高分）> `searchHint` 匹配（中分）> 描述匹配（低分）
- 描述 memoize 缓存基于工具集合变化失效，避免重复获取

## 前后呼应

- 本节的 `shouldDefer` 字段，是 **[7-2 节](./7-2-工具的输入验证Zod-Schema实战.md)** 里 `buildTool()` 默认值的一个字段
- 本节的工具 token 计算阈值，与 **[13-1 节](./13-1-Token窗口的上限与长会话问题.md)** 的上下文窗口管理是关联的——都在管理有限的 token 预算

## 第七章小结

至此，第七章完整讲解了 Claude Code 的工具系统：

```
工具定义（Tool 接口 + Zod Schema）
         ↓
工具注册（assembleToolPool：内置工具 + MCP 工具，排序保证缓存稳定）
         ↓
工具请求（Claude 发 tool_use，partitionToolCalls 分批）
         ↓
权限检查（规则匹配 → 工具自定义 → 用户确认）
         ↓
工具执行（tool.call()，结果超限存磁盘）
         ↓
文件状态跟踪（readFileState 防止编辑过时版本）
         ↓
延迟加载（ToolSearch：按需加载工具 Schema，节省 token）
```

每一步都有明确的设计动机：并发安全、权限最小化、乐观锁、token 经济学。理解了这个系统，你就理解了一个 AI Agent 的工具层是怎么构建的。

## 下一章预告

工具层讲完了。第八章进入主流程——用户在终端输入了一条消息，然后什么？这条消息是怎么变成一个 API 请求的？

➡️ [下一节：8-1 用户在终端输入时发生了什么](./8-1-用户在终端输入时发生了什么.md)
