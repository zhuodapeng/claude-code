# 9-9 认知反转：queryLoop 不是请求-响应，而是状态机

## 本节要解决的问题

你已经看完了 queryLoop() 的九个细节切面。现在，把所有这些细节放在一起，思考一个问题：

**为什么 queryLoop() 需要这么多 `continue`？为什么有的 `continue` 要修改 state，有的不修改？为什么有些 continue 只能走一次？**

如果你用"while 循环调 API"的视角来理解这些问题，答案是"特殊情况太多了"。但如果换一个视角——**状态机**——所有这些"特殊情况"都是从同一个统一模型自然推导出来的。

---

## 两种心智模型的对比

### 心智模型 A：请求-响应循环

这是大多数人第一眼看到 `queryLoop()` 时的理解：

```
while (true) {
  1. 发送消息给 Claude（callModel）
  2. 处理 Claude 的响应
  3. 如果 Claude 要用工具，执行工具
  4. 把工具结果加到消息历史
  5. 如果没有工具，返回
}
```

这个模型能解释正常路径。但碰到异常情况，它就开始"打补丁"：

- "API 返回 413？哦，是特殊情况，需要压缩"
- "Claude 回复突然被截断？哦，是特殊情况，需要重试"
- "Stop hook 报错？哦，是特殊情况，需要带错误信息重试"
- "上下文快满了？哦，是特殊情况，需要提前拦截"

特殊情况越来越多，心智模型变成了"正常流程 + 无数补丁"。

### 心智模型 B：状态机

状态机模型的核心假设不同：**每一次循环迭代不是"重复执行同一件事"，而是"从某个状态出发，经过处理，转移到下一个状态"。**

从这个角度：

- "API 返回 413" 是状态 `RESPONDING` → 状态 `COMPACTING` 的触发事件
- "Stop hook 报错" 是状态 `STOP_HOOK_CHECKING` → 状态 `REQUESTING`（带错误历史）的触发事件
- "API 返回截断" 是状态 `RESPONDING` → 状态 `REQUESTING`（扩大 max_tokens）的触发事件

所有这些"特殊情况"都是**明确的状态转移**，不是补丁，而是设计。

---

## 代码中的状态机证据

### State 类型就是机器状态

**文件：[src/query.ts](../src/query.ts#L268-L279)**

```typescript
let state: State = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  maxOutputTokensOverride: params.maxOutputTokensOverride,
  autoCompactTracking: undefined,
  stopHookActive: undefined,
  maxOutputTokensRecoveryCount: 0,    // ← "我已经恢复过几次了"
  hasAttemptedReactiveCompact: false, // ← "我已经尝试过主动压缩了吗"
  turnCount: 1,
  pendingToolUseSummary: undefined,
  transition: undefined,              // ← "我是如何来到这个状态的"
}
```

注意 `transition: undefined`——这是初始状态，它没有来源（不是从某个前置状态转移过来的）。

### transition.reason 就是转移边标签

每个 `continue` 语句都不是裸奔的——它在修改 `state` 时设置 `transition.reason`，记录"为什么会走到这里"：

| `transition.reason` | 含义 |
|---|---|
| `undefined` | 初始状态，queryLoop 刚开始 |
| `'next_turn'` | 正常进行：工具执行完毕，进入下一轮 |
| `'reactive_compact_retry'` | 触发了 API 413，reactive compact 压缩成功，重试 |
| `'collapse_drain_retry'` | 触发了 API 413，context collapse 排空暂存数据，重试 |
| `'max_output_tokens_escalate'` | Claude 回复被截断（end_turn 而非 max_tokens），扩大 max_tokens 后重试 |
| `'max_output_tokens_recovery'` | Claude 回复被截断（max_tokens），带截断提示重试 |
| `'stop_hook_blocking'` | Stop hook 报错，把错误加入历史后重试 |
| `'token_budget_continuation'` | Extended thinking token budget 用尽，带续写指令重试 |

这不是巧合——这是**显式的状态机设计**。每一条转移边都有名字，代码里都可以根据 `transition.reason` 做条件判断（比如 `state.transition?.reason !== 'collapse_drain_retry'` 防止无限循环）。

---

## 完整状态图

用状态机的语言重新描述整个 queryLoop()：

```
                        ┌──────────────────┐
                        │   [初始状态]      │
                        │ transition=undef  │
                        └────────┬─────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
              ┌────►│  GUARD_CHECK           │◄──────┐
              │     │  检查 blocking_limit    │       │
              │     └───────┬────────────────┘       │
              │             │ 未超限                  │
              │             ▼                         │
              │     ┌────────────────────────┐        │
              │     │  REQUESTING            │        │
              │     │  callModel()           │        │
              │     └───────┬────────────────┘        │
              │             │                         │
              │      ┌──────┴──────┐                  │
              │   413│             │正常响应            │
              │      ▼             ▼                   │
              │ ┌─────────┐  ┌──────────────────────┐ │
              │ │COMPACTING│  │  STREAMING           │ │
              │ │reactive  │  │  text_delta          │ │
              │ │compact   │  │  tool_use blocks     │ │
              │ └──┬───────┘  └────────┬─────────────┘ │
              │    │压缩成功            │              │
              │    │                   │              │
              │    │              ┌────┴──────────┐   │
              │    │         false│               │true│
              │    │              ▼               ▼   │
              │    │        ┌──────────┐  ┌────────────┐
              │    │        │STOP_HOOK │  │TOOL_EXEC   │
              │    │        │CHECKING  │  │runTools()  │
              │    │        └───┬──────┘  └─────┬──────┘
              │    │            │               │
              │    │   ┌────────┴──────┐        │
              │    │   │prevent?│block?│        │
              │    │   ▼        ▼      │        │
              │    │  TERM    ┌─┴──────┴────────┤
              │    │ stop_    │ stop_hook_       │
              │    │ hook_    │ blocking         │
              │    │ prevented│ (continue)       │
              │    │          └──────────────────┤
              │    │                             │
              │    │                         next_turn
              │    │                             │
              └────┴─────────────────────────────┘
                         （下一次迭代）

最终吸收状态（Terminal）：
  completed / max_turns / blocking_limit /
  model_error / image_error / prompt_too_long /
  aborted_streaming / aborted_tools /
  stop_hook_prevented / hook_stopped
```

---

## 防止无限循环的守卫字段

状态机中有些状态只能到达一次——这是通过 `State` 中的计数/标志字段来保证的：

### maxOutputTokensRecoveryCount

**文件：[src/query.ts](../src/query.ts#L1196-L1250)**

```typescript
if (isMaxTokens && maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_ATTEMPTS) {
  // 进入 max_output_tokens_recovery 转移
  state = {
    ...state,
    maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
    transition: {
      reason: 'max_output_tokens_recovery',
      attempt: maxOutputTokensRecoveryCount + 1,
    },
  }
  continue
}
```

每次 `max_output_tokens_recovery` 转移，计数器加一。当计数器达到上限，这条转移边就消失了——状态机的"恢复弧"只能走有限次，避免无限重试。

### hasAttemptedReactiveCompact

```typescript
if (!hasAttemptedReactiveCompact && reactiveCompact) {
  // 进入 reactive_compact_retry 转移
  state = {
    ...state,
    hasAttemptedReactiveCompact: true,  // ← 永久关闭这条边
    transition: { reason: 'reactive_compact_retry' },
  }
  continue
}
```

reactive compact 只能尝试一次。如果压缩后再次触发 413，就不能再次压缩（消息太少，压缩没有效果）——直接走 `prompt_too_long` 终止路径。

### transition.reason !== 'collapse_drain_retry'

```typescript
if (
  feature('CONTEXT_COLLAPSE') &&
  contextCollapse &&
  state.transition?.reason !== 'collapse_drain_retry'  // ← 如果上次已经是这个原因，跳过
) {
  // 进入 collapse_drain_retry 转移
}
```

这是一个不同风格的守卫：不用计数器，而是直接检查"上一次转移原因"。如果刚刚做了 `collapse_drain_retry` 还是 413，说明 collapse 已经没有更多可以排空的内容，不再重试。

**这些守卫字段的本质**：状态机的某些转移边是"一次性的"。用状态里的字段来"烧断"这些边，是防止振荡和无限循环的经典方法。

---

## 状态机视角如何解释每个设计决策

### 为什么所有 `continue` 都要写完整的 `state = {...}`？

因为每次 `continue` 都是一次**状态转移**。你不能只修改某一个字段然后 `continue`——你需要原子性地构建新状态（包括设置 `transition.reason`），然后让循环用这个新状态运行下一轮。

如果直接 `mutate` 局部变量然后 `continue`：
- 不原子：某些字段可能处于中间状态
- 丢失 transition 信息：无法判断"上次是怎么来的"

`state = { ...state, someField: newValue, transition: { reason: '...' } }` 的写法是**函数式状态更新**——每次转移都生成一个新状态对象，不修改旧对象。

### 为什么 Terminal 是返回值而不是抛出的异常？

因为 Terminal 是状态机的**吸收状态**（absorbing state）——进入之后不再转移，函数返回。它不是"错误"，它是"机器运行完成"的正常结果。

```typescript
async function* queryLoop(...): AsyncGenerator<..., Terminal>
//                                              ↑ return type = 最终状态
```

把 Terminal 作为返回类型，调用者（`query()` → `submitMessage()`）可以通过返回值知道机器是如何结束的，做出相应处理。如果用异常，你只能知道"机器崩了"，但用返回值，你可以知道"机器因为 `max_turns` 正常停止了"。

### 为什么有 10 种 Terminal，而不是简单的 success/error？

因为不同的终止状态需要不同的**上游响应**：

- `max_turns` → SDK 调用者显示"轮次已达上限，如需继续请增加 maxTurns"
- `model_error` → UI 显示 API 错误，可能建议重试
- `aborted_streaming` → 需要补全 `yieldMissingToolResultBlocks`，保证消息合法性
- `completed` → 正常完成，显示结果

如果只有 success/error，调用者就失去了足够的信息来做精细化处理。**Terminal 的 10 种 reason 就是状态机最终状态的"分类标签"**，让调用者可以区别对待。

---

## 与其他系统的对比

### Redux：状态机的显式实现

Redux 的核心就是一个状态机：

```
state = reducer(state, action)
```

`action.type` 对应 `transition.reason`，`reducer` 对应循环体里的 `switch` 逻辑，`state` 对应 `State`。

Redux 还强制"immutable update"（`{...state, field: newValue}`），queryLoop() 的 `state = {...}` 写法采用了同样的原则——虽然这是命令式循环，但状态更新是函数式的。

### XState：显式状态机 DSL

如果你熟悉 XState，你可以把 queryLoop() 的设计翻译成 XState 配置：

```typescript
const queryMachine = createMachine({
  id: 'queryLoop',
  initial: 'guard_check',
  states: {
    guard_check: {
      on: {
        AT_BLOCKING_LIMIT: 'terminated.blocking_limit',
        OK: 'requesting',
      },
    },
    requesting: {
      on: {
        RESPONSE_413: 'compacting',
        RESPONSE_TRUNCATED: 'recovery.max_output_tokens',
        RESPONSE_OK: 'streaming',
        ERROR: 'terminated.model_error',
      },
    },
    streaming: {
      on: {
        HAS_TOOL_USE: 'tool_exec',
        NO_TOOL_USE: 'stop_hook_checking',
        USER_ABORT: 'terminated.aborted_streaming',
      },
    },
    tool_exec: {
      on: {
        DONE: 'guard_check',  // next_turn
        USER_ABORT: 'terminated.aborted_tools',
        HOOK_STOPPED: 'terminated.hook_stopped',
      },
    },
    stop_hook_checking: {
      on: {
        PREVENTED: 'terminated.stop_hook_prevented',
        BLOCKING_ERROR: 'guard_check',  // stop_hook_blocking
        OK: 'terminated.completed',
      },
    },
    // ... 其他恢复状态
  },
})
```

queryLoop() 没有使用 XState（因为这是纯粹的 TypeScript 代码，不需要额外依赖），但它的设计思想是一样的。

### 浏览器事件循环

浏览器的事件循环也是一个状态机：等待事件 → 处理事件 → 等待事件 → ...。queryLoop() 的 `while(true)` 是类似的宏观结构：等待 API → 处理响应 → 执行工具 → 等待 API → ...

区别在于 queryLoop() 有明确的**终止条件**（Terminal），而浏览器事件循环理论上永远运行。

---

## 实践启示：如何向新人解释 queryLoop()

有了状态机视角，你可以这样解释 queryLoop() 的工作原理：

> queryLoop() 是一个状态机，状态是 `State` 对象，转移是 `state = {..., transition: { reason: '...' }}; continue`，最终进入吸收状态 `Terminal`。
>
> 正常工作流是：初始状态 → 检查上下文 → 调用 API → 处理流式响应 → 执行工具 → 回到检查上下文。
>
> 错误恢复是特定的状态转移：413 → 压缩 → 重试；截断 → 扩大 max_tokens → 重试。每种恢复路径都有守卫条件防止无限循环。
>
> 十种 Terminal 是十种最终状态，描述了机器"为什么停下来了"。

这个解释比"while 循环 + 很多特殊情况"更准确，也更容易让新人形成正确的预期：当他们看到某个新的 `continue`，他们会自然地问"这是什么状态转移？转移条件是什么？这条边需要守卫吗？"而不是"又是一个补丁"。

---

## 本节小结

- queryLoop() 的核心模型是**状态机**，不是"请求-响应循环 + 特殊情况"
- `State` 类型是机器状态，`transition.reason` 是转移边标签，`Terminal` 是最终吸收状态
- 所有 `continue` 都是显式的**状态转移**，通过 `state = {..., transition: {...}}` 完成
- 守卫字段（`maxOutputTokensRecoveryCount`、`hasAttemptedReactiveCompact`、检查 `transition.reason`）防止状态机在恢复弧上无限循环
- 这个视角让"特殊情况"变成了"设计好的转移边"，使整个系统更容易理解和维护

## 前后呼应

- 所有状态转移边在本章前八节都已详细讲解：`next_turn`（9-7），各种错误恢复（9-8），streaming/tool_exec（9-5、9-6）
- 函数式状态更新（`state = {...state, ...}`）的思想来源与 **[4-4 节](./4-4-外部状态存储为什么不用useState.md)** 的状态管理理念一脉相承

## 下一节预告

我们已经深入研究了 queryLoop() 这一层。但 queryLoop() 外面还包着 query()，query() 外面还包着 QueryEngine。这个两层封装解决了什么问题？

➡️ [下一节：10-1 QueryEngine vs query()：为什么需要两层](./10-1-QueryEngine-vs-query两层架构.md)
