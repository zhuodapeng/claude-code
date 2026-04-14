# 13-2 AutoCompact 触发时机

## 问题引入：触发压缩听起来简单，实际上要处理很多边界情况

有了 token 阈值之后，自然的想法是：每次准备调 API 之前，先检查 token 数是否超阈值，超了就压缩。

但如果仅仅是这样，会遇到至少三个陷阱：

1. **死递归**：压缩本身需要调用 Claude。如果在"压缩 Agent 内部"又触发了压缩，就会无限嵌套。
2. **徒劳重试**：某些场景下 context 已经超限到无法恢复，但系统每轮都重试压缩，浪费大量 API 调用。
3. **功能冲突**：新版本引入了 Context Collapse、Reactive Compact 等替代机制，Auto Compact 与它们同时工作会产生竞态。

`shouldAutoCompact()` 和 `autoCompactIfNeeded()` 这两个函数，就是在处理这些边界情况。

---

## 调用位置：压缩在 query 循环的哪里发生

先看触发点在哪。Auto Compact 在每一轮 query 循环的**微压缩之后、API 调用之前**触发：

**文件：[src/query.ts](../src/query.ts#L412-L468)**

```
query 循环一轮的执行顺序：

  1. 从上轮继承 messagesForQuery
  2. 工具结果预算裁剪 (tool result budget)
  3. Snip (历史裁剪，减少旧消息大小)
          ↓
  4. Microcompact（微压缩，收缩工具结果）          ← L413
          ↓
  5. Context Collapse 投影（实验性特性）
          ↓
  6. ★ deps.autocompact(...)                        ← L454
          ↓
  7. 如果触发压缩 → yield 新消息 → 替换 messagesForQuery
          ↓
  8. 构建 systemPrompt + systemContext
          ↓
  9. 调用 Anthropic API（stream）
```

关键点：autocompact 在 microcompact **之后**、API 调用**之前**。这确保了当 autocompact 做判断时，microcompact 已经尽力压缩过了——如果微压缩已经把 token 压下来了，autocompact 可能就不需要触发了。

`deps.autocompact` 是依赖注入，实际指向 [`autoCompactIfNeeded()`](../src/services/compact/autoCompact.ts#L241)。

---

## shouldAutoCompact：五层过滤

[`shouldAutoCompact()`](../src/services/compact/autoCompact.ts#L160) 是一个纯判断函数，返回 boolean，不做任何实际操作：

**文件：[src/services/compact/autoCompact.ts](../src/services/compact/autoCompact.ts#L160-L239)**

```typescript
export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  snipTokensFreed = 0,  // snip 已经释放的 token，从估算中扣除
): Promise<boolean> {

  // ── 过滤层 1：递归守卫 ──────────────────────────────────────
  // session_memory 和 compact 都是派生 Agent，它们会继承完整的消息历史
  // 如果在这些 Agent 内部又触发压缩，就会无限嵌套
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }

  // ── 过滤层 2：实验性 feature 守卫（内部 build 才生效）──────
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {  // context collapse 的内部 agent
      return false
    }
  }

  // ── 过滤层 3：用户设置守卫 ──────────────────────────────────
  if (!isAutoCompactEnabled()) {
    return false  // 环境变量或用户设置关闭了 Auto Compact
  }

  // ── 过滤层 4：实验性替代机制守卫 ────────────────────────────
  // 如果启用了 Reactive Compact（被动模式），则禁用主动式 Auto Compact
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }
  // 如果启用了 Context Collapse（更细粒度的上下文管理），也禁用
  if (feature('CONTEXT_COLLAPSE')) {
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  // ── 过滤层 5：阈值检查 ───────────────────────────────────────
  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
  )

  return isAboveAutoCompactThreshold
}
```

五层过滤的设计顺序很有讲究：**越廉价的检查越靠前**。递归守卫只是字符串比较，代价几乎为零；而 `tokenCountWithEstimation()` 需要遍历所有消息，代价较高——它放在最后，只在前面所有守卫都通过之后才执行。

---

## 熔断器：阻止无效重试

如果压缩失败（比如 context 已经大到连压缩请求本身都超限），系统不应该每轮都重试。这是 [`autoCompactIfNeeded()`](../src/services/compact/autoCompact.ts#L241) 里的熔断器：

**文件：[src/services/compact/autoCompact.ts](../src/services/compact/autoCompact.ts#L257-L265)**

```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3  // autoCompact.ts:70

// 连续失败次数达到上限，停止重试
if (
  tracking?.consecutiveFailures !== undefined &&
  tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
) {
  return { wasCompacted: false }
}
```

代码注释里有一条数据（L68-L70）：

```
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
```

这是从生产遥测里发现的真实问题：在某些 context 已经完全撑满的会话里，系统会反复重试压缩，每次都失败，最终一个会话里失败了 3,272 次。这浪费了全球 25 万次/天的 API 调用。熔断器在 3 次失败后停止，直接消除了这个问题。

---

## autoCompactIfNeeded：完整执行路径

[`autoCompactIfNeeded()`](../src/services/compact/autoCompact.ts#L241) 是实际的压缩控制器，整合了熔断器、判断函数、两种压缩路径和失败计数：

**文件：[src/services/compact/autoCompact.ts](../src/services/compact/autoCompact.ts#L241-L351)**

```
autoCompactIfNeeded(messages, toolUseContext, ...)
│
├─ 检查 DISABLE_COMPACT 环境变量
│
├─ 熔断器：consecutiveFailures >= 3？ → 直接返回 { wasCompacted: false }
│
├─ shouldAutoCompact() → false？ → 返回 { wasCompacted: false }
│
├─ 路径 A：trySessionMemoryCompaction()
│   └─ 如果 session memory 管理器能压缩（实验性特性）
│       → 返回 { wasCompacted: true, compactionResult }
│
└─ 路径 B：compactConversation()   ← 主路径
    ├─ 成功 → 返回 { wasCompacted: true, compactionResult, consecutiveFailures: 0 }
    └─ 失败 → 返回 { wasCompacted: false, consecutiveFailures: prev + 1 }
```

失败时，连续失败次数 +1 被传回给 query.ts，存入 `tracking` 对象，在下一轮循环里用于熔断器判断。

**query.ts 侧如何处理压缩结果**（[src/query.ts](../src/query.ts#L536-L542)）：

```typescript
} else if (consecutiveFailures !== undefined) {
  // 压缩失败——把失败次数传播出去，让熔断器下一轮能生效
  tracking = {
    ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
    consecutiveFailures,
  }
}
```

这是经典的"状态在循环外积累"模式：`tracking` 对象在每一轮循环结束时被更新，下一轮循环开始时被读取，形成跨轮次的记忆。

---

## AutoCompactTrackingState：跨轮次的压缩记忆

**文件：[src/services/compact/autoCompact.ts](../src/services/compact/autoCompact.ts#L51-L60)**

```typescript
export type AutoCompactTrackingState = {
  compacted: boolean          // 本次 session 是否发生过压缩
  turnCounter: number         // 上次压缩后经历了几轮对话
  turnId: string              // 每次压缩的唯一 ID（用于遥测）
  consecutiveFailures?: number  // 连续失败次数（熔断器）
}
```

这四个字段各司其职：
- `compacted` + `turnCounter`：遥测用，帮助 Anthropic 了解"压缩后 X 轮又会触发再次压缩"的分布
- `turnId`：关联多个事件（压缩事件和后续的 `tengu_post_autocompact_turn` 事件）
- `consecutiveFailures`：熔断器的核心状态

---

## 本节小结

`shouldAutoCompact()` 的五层守卫确保了：递归不死锁、用户设置被尊重、与实验性机制不冲突，最后才做 token 计数。`autoCompactIfNeeded()` 的熔断器（3次失败停止）解决了生产环境里的真实问题。触发点固定在 query 循环的"微压缩之后、API 调用之前"，这个顺序是有意设计的。

## 前后呼应

- 本节提到了 `querySource` 用于区分"主线程 vs 派生 Agent"——这与 **[9-1 节](./9-1-queryLoop的全局结构.md)** 讲的 query 循环结构密切相关，当时介绍了 querySource 如何标识不同的调用来源。
- 本节的熔断器 `consecutiveFailures` 是 `AutoCompactTrackingState` 的一个字段——它在 **[13-4 节](./13-4-压缩后的消息结构.md)** 里还会出现，届时会看到整个 tracking 对象在 query 循环中如何流转。

## 下一节预告

下一节深入 `compactConversation()` 的内部：Claude 是怎么被要求总结自己的？那个 9 节的 prompt 模板是什么？为什么要剥离图片？PTL 重试是什么？

➡️ [下一节：13-3 压缩的实现：让 Claude 总结自己](./13-3-压缩的实现让Claude总结自己.md)
