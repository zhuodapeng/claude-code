# 13-1 Token 窗口的上限与长会话问题

## 问题引入：长对话为什么会"撑破"？

假设你在用 Claude Code 处理一个复杂的重构任务：读了 20 个文件，来回讨论了 50 轮，工具调用的结果一条条堆在消息历史里。某一刻，你发一条新消息，却什么都没发生——或者 Claude 突然说 "I cannot continue"。

这不是 bug，是物理限制击中了你：**LLM 每次推理时能"看到"的内容是有上限的**，这个上限叫做 context window（上下文窗口），用 token 衡量。

Claude Code 的整个 Auto Compact 系统，就是为了让你在接近这个上限之前自动"腾空间"，而不是让你撞墙之后再手动处理。

---

## 直觉方案：为什么不直接截断？

最朴素的想法：超过上限就把最老的消息删掉。

为什么不行？
- **丢失上下文**：Claude 在第 5 轮里看了一个文件，第 50 轮要修改它——如果第 5 轮被删了，Claude 就像失忆了一样。
- **破坏工具调用序列**：API 要求 tool_use 和 tool_result 必须成对出现。随意截断会让 API 拒绝整个请求。
- **没有摘要，就没有信息**：硬截断丢掉的是原始信息，没有任何"理解"留下来。

Claude Code 选择的方案是：**让 Claude 自己总结自己的历史**，用摘要替换旧消息。这就是 compact（压缩）机制。

但在触发压缩之前，系统需要知道"现在到底用了多少 token"，以及"什么时候该触发"。

---

## 有效上下文窗口：并非全部空间都能用

你可能以为 claude-opus-4 有 200K token 的窗口，就能往里塞 200K token 的消息。实际上，**一部分空间必须留给输出**。

[`getEffectiveContextWindowSize()`](../src/services/compact/autoCompact.ts#L33) 计算的正是这个"有效输入空间"：

**文件：[src/services/compact/autoCompact.ts](../src/services/compact/autoCompact.ts#L33-L49)**

```typescript
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),   // 模型自身的输出上限
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,        // 固定上限：20_000
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  // 允许用环境变量强制缩小（方便测试压缩逻辑）
  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
  // 例如：200_000 - 20_000 = 180_000
}
```

`MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000` 来自注释："p99.99 of compact summary output being 17,387 tokens"——这是 Anthropic 从生产日志里统计出来的真实数字，不是随手拍的。预留 20K 是为了确保压缩摘要本身有足够空间生成，而不会因为输出超限而被截断。

---

## 四条警戒线：Token 使用量的不同阶段

系统定义了四个缓冲常量，各有用途：

**文件：[src/services/compact/autoCompact.ts](../src/services/compact/autoCompact.ts#L62-L65)**

```typescript
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000    // 自动压缩触发缓冲
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000  // 警告显示缓冲
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000    // 错误显示缓冲
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000  // 硬拦截缓冲
```

结合 [`calculateTokenWarningState()`](../src/services/compact/autoCompact.ts#L93) 的逻辑，可以画出这四条线：

```
0                        effectiveContextWindow (180K)
├──────────────────────────────────────────────────────┤
                                            ↑
                             ─ 3K ─ MANUAL_COMPACT_BUFFER
                             = blockingLimit (177K)
                             用户手动 /compact 的最后关口
                                        ↑
                      ─ 13K ─ AUTOCOMPACT_BUFFER
                      = autoCompactThreshold (167K)
                      触发自动压缩的阈值
                                    ↑
              ─ 20K ─ WARNING/ERROR_THRESHOLD_BUFFER
              = warningThreshold / errorThreshold (160K)
              UI 显示橙/红色警告条
```

具体来说，当 `tokenUsage` 增长时，会依次触发：

| 阶段 | 条件 | 用途 |
|---|---|---|
| 绿色 | tokenUsage < 160K | 正常 |
| 橙色警告 | tokenUsage ≥ 160K | UI 显示警告条 |
| 红色错误 | tokenUsage ≥ 160K（同上） | UI 变红 |
| 自动压缩 | tokenUsage ≥ 167K | 触发 Auto Compact |
| 硬拦截 | tokenUsage ≥ 177K | 直接拒绝新消息 |

注意 WARNING 和 ERROR 的 buffer 是相同值（20K），它们用不同颜色区分，但触发阈值相同。重要的是 autocompact（13K buffer）触发早于 blocking（3K buffer），给压缩操作留有 10K token 的"施工空间"。

---

## 如何判断是否开启了 Auto Compact

在检查阈值之前，系统先判断用户是否启用了 Auto Compact：

**文件：[src/services/compact/autoCompact.ts](../src/services/compact/autoCompact.ts#L147-L158)**

```typescript
export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false  // 完全禁用（包括手动 /compact）
  }
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false  // 只禁用自动压缩，保留手动 /compact
  }
  // 读取用户在设置文件里的配置
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}
```

两个环境变量的粒度不同：
- `DISABLE_COMPACT=true`：彻底关掉所有压缩（包括 `/compact` 命令）
- `DISABLE_AUTO_COMPACT=true`：只关掉自动触发，手动 `/compact` 还能用

这种分层设计让开发者可以在测试环境或特殊场景里精细控制行为，而不是只有"全开"或"全关"。

---

## getAutoCompactThreshold：触发阈值的计算

触发自动压缩的实际 token 数由 [`getAutoCompactThreshold()`](../src/services/compact/autoCompact.ts#L72) 计算：

**文件：[src/services/compact/autoCompact.ts](../src/services/compact/autoCompact.ts#L72-L91)**

```typescript
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)

  // 正常阈值 = 有效窗口 - 13K 缓冲
  const autocompactThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS

  // 允许用百分比覆盖（方便在小窗口测试）
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      // 取较小值，确保不超过正常阈值
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}
```

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 环境变量的存在说明这套机制需要被频繁测试：你可以设置 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=10` 来让系统在只用了 10% 窗口时就触发压缩，从而在短会话里验证整个压缩流程是否正确。

---

## 本节小结

Auto Compact 的物理前提：LLM context window 是有限的，长对话会超出上限。Claude Code 的解决思路是用 Claude 自己生成摘要替换历史，而不是简单截断。核心设计点是"有效窗口"（总窗口 - 预留输出空间）和四条警戒线——自动压缩触发点（-13K）比硬拦截点（-3K）早 10K，确保压缩本身能完成。

## 前后呼应

- 本节提到的 `tokenCountWithEstimation()` 是如何估算 token 数的？这是个有趣的工程问题，涉及到在没有精确 API 计数时如何快速估算——可以在源码 `src/utils/tokens.ts` 里深入探索。
- 本节介绍的阈值和常量，在 **[13-2 节](./13-2-AutoCompact触发时机.md)** 里会看到它们如何在 `shouldAutoCompact()` 中被实际使用。

## 下一节预告

下一节我们看 Auto Compact 在哪里被触发，以及触发判断中有哪些"防护栏"——递归守卫、特性开关、熔断器。

➡️ [下一节：13-2 AutoCompact 触发时机](./13-2-AutoCompact触发时机.md)
