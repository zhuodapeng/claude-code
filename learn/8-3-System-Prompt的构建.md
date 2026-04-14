# 8-3 System Prompt 的构建：从 string[] 到 API 请求

## 本节要解决的问题

上一节讲到，`getSystemPrompt()` 返回的是一个 `string[]`，内容按静态/动态分区，用 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 隔开。但 Anthropic API 的 `system` 字段不接受 `string[]`——它接受 `TextBlockParam[]`，每个 block 可以带 `cache_control` 字段。

工程问题很具体：**如何把内部的 `string[]` 翻译成 API 要求的 `TextBlockParam[]`，同时附上正确的 `cache_control` 标记，最大化缓存命中率？**

这一节拆解的就是这个翻译过程——两个函数：`splitSysPromptPrefix()` 和 `buildSystemPromptBlocks()`。

---

## 先搞清楚：Prompt Caching 值多少钱

要理解缓存逻辑，必须先理解动机。

Anthropic 的 Prompt Caching 工作原理：当你在 system block 上标记 `cache_control: { type: 'ephemeral' }`，API 会把这个 block（以及之前所有 block）的 KV 缓存在服务器上。下次请求如果前缀完全相同，就可以直接复用 KV cache，不需要重新计算这部分的 attention，**缓存命中的 token 只收 10% 的价格**。

Claude Code 的 System Prompt 大约有 20,000–30,000 个 token（包含所有章节说明、工具描述等）。每次用户发一条消息，就要重新发送这些 token。如果全部命中缓存，这部分成本降到 1/10。

所以**缓存是强烈的成本优化动机**，而不是可选的性能改进。

但有一个约束：**Anthropic API 规定每次请求最多只能有 4 个 system block，且 `cache_control` 的使用有限制**。这就是为什么缓存策略需要精心设计。

---

## 构建链的起点：attribution header + CLI prefix

在 `src/services/api/claude.ts` 的主 API 调用函数里，在调用 `buildSystemPromptBlocks()` 之前，还有一步预处理：给 system prompt 头部加上两个固定块。

**文件：[src/services/api/claude.ts](../src/services/api/claude.ts#L1358-L1369)**

```typescript
systemPrompt = asSystemPrompt(
  [
    getAttributionHeader(fingerprint),      // 第一块：归因 header
    getCLISyspromptPrefix({                 // 第二块：CLI 身份前缀
      isNonInteractive: options.isNonInteractiveSession,
      hasAppendSystemPrompt: options.hasAppendSystemPrompt,
    }),
    ...systemPrompt,                        // 第三块起：原始 system prompt 内容
    ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
    ...(injectChromeHere ? [CHROME_TOOL_SEARCH_INSTRUCTIONS] : []),
  ].filter(Boolean),  // 过滤掉空字符串
)
```

**attribution header** 是什么？看 `src/constants/system.ts:73`：

```typescript
const header = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${cch}${workloadPair}`
```

这不是 HTTP header，而是一个字符串，放在 system prompt 的**第一个 block** 里。Anthropic 服务器通过解析这个字段来识别请求来自哪个 Claude Code 版本、哪种入口（CLI/VSCode/Web），用于计费归因和流量追踪。

**CLI prefix** 是什么？来自 `src/constants/system.ts:14-18`：

```typescript
const DEFAULT_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude.`
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`
const AGENT_SDK_PREFIX = `You are a Claude agent, built on Anthropic's Claude Agent SDK.`
```

根据运行模式选择不同前缀——普通 CLI 用第一个，SDK 调用用后两个。这就是为什么你在每次对话开头看到的身份描述会有所不同。

这步完成后，`systemPrompt` 的 `string[]` 结构如下：

```
[
  "x-anthropic-billing-header: cc_version=...",    // attribution
  "You are Claude Code, Anthropic's...",           // CLI prefix
  "# System\n ...",                               // 静态内容（原始 prompt）
  "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",           // 分界标记
  "# Session\n...",                               // 动态内容
  ...
]
```

---

## 第一步：splitSysPromptPrefix() — 分析结构，打 cacheScope 标签

**文件：[src/utils/api.ts](../src/utils/api.ts#L321-L435)**

这个函数把 `string[]` 转成 `SystemPromptBlock[]`，每个 block 携带一个 `cacheScope` 元数据字段：

```typescript
type SystemPromptBlock = {
  text: string
  cacheScope: CacheScope | null  // 'global' | 'org' | null
}
```

`cacheScope: null` 表示"这个 block 不加 cache_control 标记"；`'org'` 表示组织级缓存；`'global'` 表示全局缓存（跨组织共享）。

函数根据运行条件走三条不同路径：

### 路径一：有 MCP 工具（skipGlobalCacheForSystemPrompt = true）

```
输入 string[]
    ↓
过滤掉 BOUNDARY 标记
    ↓
按内容分类：
  attribution header → cacheScope: null
  CLI prefix         → cacheScope: 'org'
  其余所有内容拼接   → cacheScope: 'org'
    ↓
输出最多 3 个 block
```

为什么 MCP 工具要特殊处理？

MCP 工具的 schema 是用户动态连接的，每个用户的工具列表不一样。工具描述会出现在 system prompt 里（或者 tools 数组里），这些内容**不可能被全局缓存**——全局缓存意味着不同用户共享同一份缓存，但工具 schema 是用户特定的。

所以：MCP 工具存在时，系统切换到"工具侧 cache marker"策略（`needsToolBasedCacheMarker = true`），system prompt 只做 org 级缓存，真正的 cache 断点放在工具 schema 数组上。

### 路径二：全局缓存模式 + 有 BOUNDARY 标记（主路径）

```
输入 string[]，包含 BOUNDARY 标记
    ↓
找到 BOUNDARY 的位置 boundaryIndex
    ↓
按位置和内容分类：
  attribution header              → cacheScope: null（不缓存）
  CLI prefix                     → cacheScope: null（不缓存）
  BOUNDARY 之前的内容（静态区）   → cacheScope: 'global'（全局缓存）
  BOUNDARY 之后的内容（动态区）   → cacheScope: null（不缓存）
    ↓
输出最多 4 个 block
```

**文件：[src/utils/api.ts](../src/utils/api.ts#L362-L409)**

```typescript
if (useGlobalCacheFeature) {
  const boundaryIndex = systemPrompt.findIndex(
    s => s === SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  )
  if (boundaryIndex !== -1) {
    // ...分类...
    const result: SystemPromptBlock[] = []
    if (attributionHeader)
      result.push({ text: attributionHeader, cacheScope: null })    // 不缓存
    if (systemPromptPrefix)
      result.push({ text: systemPromptPrefix, cacheScope: null })   // 不缓存
    const staticJoined = staticBlocks.join('\n\n')
    if (staticJoined)
      result.push({ text: staticJoined, cacheScope: 'global' })    // 全局缓存！
    const dynamicJoined = dynamicBlocks.join('\n\n')
    if (dynamicJoined) result.push({ text: dynamicJoined, cacheScope: null })  // 不缓存
    return result
  }
}
```

这里有一个值得注意的细节：**attribution header 和 CLI prefix 在全局缓存模式下不打缓存标记**。这是因为这两个 block 是全局缓存的"前置内容"——API 的缓存是基于前缀匹配的，这两个 block 要尽量稳定，不能扰乱静态内容的缓存命中。

### 路径三：默认/回退路径

```
attribution header → cacheScope: null
CLI prefix         → cacheScope: 'org'
其余所有内容拼接   → cacheScope: 'org'
```

用于：3P 提供商（Bedrock/Vertex）、全局缓存功能未开启、或者没有找到 BOUNDARY 标记。

---

## 第二步：buildSystemPromptBlocks() — 打 cache_control，生成 API block

**文件：[src/services/api/claude.ts](../src/services/api/claude.ts#L3213-L3237)**

```typescript
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): TextBlockParam[] {
  // IMPORTANT: Do not add any more blocks for caching or you will get a 400
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    }
  })
}
```

逻辑很简单：遍历 `SystemPromptBlock[]`，对每个 block：
- 如果 `enablePromptCaching` 为 false（用户禁用了缓存），所有 block 都不加 `cache_control`
- 如果 `cacheScope` 为 `null`，不加 `cache_control`（这个 block 不需要缓存）
- 否则，调用 `getCacheControl()` 生成缓存控制对象

---

## getCacheControl() 的细节：ephemeral、1h TTL、scope

**文件：[src/services/api/claude.ts](../src/services/api/claude.ts#L358-L373)**

```typescript
export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

**`type: 'ephemeral'`** 是 Anthropic API 唯一支持的缓存类型，表示"短暂缓存"（默认 5 分钟 TTL）。

**`ttl: '1h'`** 是可选的扩展：对于付费订阅用户（`isClaudeAISubscriber()`）且未超额，缓存时间延长到 1 小时。这个状态在 session 开始时锁定（`setPromptCache1hEligible`），防止中途超额导致 TTL 改变而破坏缓存。代码注释里解释了原因：

```typescript
// Latch eligibility in bootstrap state for session stability — prevents
// mid-session overage flips from changing the cache_control TTL, which
// would bust the server-side prompt cache (~20K tokens per flip).
```

**`scope: 'global'`** 是全局缓存的关键——只有 `scope === 'global'` 时才附加这个字段。全局缓存意味着缓存在 Anthropic 服务器上跨**所有用户**共享，只要请求的前缀完全相同。这就是为什么全局缓存只能用于**绝对稳定的静态内容**——任何用户特定的内容（工具 schema、自定义 system prompt）都不能进入全局缓存块。

---

## 完整转换流程图

```
getSystemPrompt() 返回 string[]
  [attribution_header, cli_prefix, static..., BOUNDARY, dynamic...]
         ↓
    claude() 函数中预处理（已由 asSystemPrompt 封装）
  [attribution_header, cli_prefix, static..., BOUNDARY, dynamic...]
         ↓
  splitSysPromptPrefix() 分析结构，打 cacheScope 标签
         ↓ （全局缓存路径）
  SystemPromptBlock[]
  ┌──────────────────────────────────────────┐
  │ { text: attribution_header, scope: null }│  → 不缓存（计费用）
  │ { text: cli_prefix,         scope: null }│  → 不缓存（小且稳定）
  │ { text: static_content,   scope:'global'}│  → 全局缓存 ✓
  │ { text: dynamic_content,   scope: null } │  → 不缓存（每次变）
  └──────────────────────────────────────────┘
         ↓
  buildSystemPromptBlocks() 转换为 API 格式
         ↓
  TextBlockParam[]（发给 API）
  ┌────────────────────────────────────────────────────────────┐
  │ { type: 'text', text: attribution_header }                 │
  │ { type: 'text', text: cli_prefix }                        │
  │ { type: 'text', text: static_content,                     │
  │   cache_control: { type: 'ephemeral',                     │
  │                    scope: 'global',                        │
  │                    ttl: '1h' } }           ← 全局缓存标记  │
  │ { type: 'text', text: dynamic_content }                   │
  └────────────────────────────────────────────────────────────┘
```

---

## 设计权衡

**为什么是 4 个 block，不能更多？**

Anthropic API 有限制：每次请求 system prompt 部分最多 4 个 block（含 cache_control 标记）。代码注释里有直接说明：

```typescript
// IMPORTANT: Do not add any more blocks for caching or you will get a 400
```

**为什么 static content 要 join 成一个 block，而不是保留多个？**

API 的缓存是**前缀级**的，不是 block 级的。两次请求必须有完全相同的前缀才能命中缓存。如果把静态内容分成多个 block，每次请求的 block 数量和内容必须精确对齐才行，而且还会浪费宝贵的"4 个 block"配额。合并成一个 block，只需要保证这个 block 内容不变即可。

**为什么动态内容不缓存？**

动态内容（日期、环境信息、scratchpad 等）每次请求都可能不同。就算打上 `cache_control`，因为内容变了，缓存也不会命中——反而白白消耗了一个 block 配额。

---

## 本节小结

- `splitSysPromptPrefix()` 把 `string[]` 分析成带 `cacheScope` 标签的 `SystemPromptBlock[]`，根据 MCP 工具是否存在、全局缓存功能是否开启、BOUNDARY 标记是否存在，走三条不同路径
- `buildSystemPromptBlocks()` 是纯转换函数：把每个 block 翻译成 `TextBlockParam`，根据 `cacheScope` 附加 `cache_control`
- `getCacheControl()` 生成 `{ type: 'ephemeral', ttl?, scope? }`，TTL 1h 是付费用户的优化，scope: 'global' 是全局共享缓存
- 整个设计受限于"API 每次请求最多 4 个缓存 block"，所以静态内容被 join 成一块，动态内容不打标记

## 前后呼应

- 本节的静态/动态 BOUNDARY，在 **[8-2 节](./8-2-processUserInput消息预处理.md)** 已经讲过它的构建
- 本节的缓存 block 最终成为 API 请求的 `system` 字段，在 **[9-2 节](./9-2-调用Anthropic-API.md)** 会看到完整的 API 调用

## 下一节预告

System Prompt 转换好了。现在来看 `submitMessage()` 的完整前半程——从接收用户输入到进入 `query()` 循环之前，究竟发生了哪些事？

➡️ [下一节：8-4 submitMessage() 的前半程](./8-4-submitMessage的前半程.md)
