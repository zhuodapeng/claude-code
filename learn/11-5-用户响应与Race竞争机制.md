# 11-5 用户响应与 Race 竞争机制

> 权限对话框弹出来，不只是在等用户点击。Hook 系统、AI 分类器、远程端（claude.ai/Telegram）都在并行等待，谁先响应谁赢。本节拆解这个多路竞争机制，以及用户的三种选择分别走哪条代码路径。

---

## 问题引入：谁来解决这个 Promise

上一节说到，流水线最终返回 `{ behavior: 'ask' }`，然后 `useCanUseTool` 调用 `handleInteractivePermission`。

但这里有个根本问题：**权限判断是一个 Promise，谁来 resolve 它？**

最简单的答案是：等用户点按钮。但 Claude Code 有很多使用场景——

- 用户配了自定义 Hook（一个 shell 脚本来决策）
- 用 claude.ai Web 界面打开了同一个会话
- 通过 Telegram Bot 接收权限通知
- Bash 分类器在后台运行，可能已经有答案了

这些路径都可以"解决"这个权限确认。但只能有一个赢家——不能多次 resolve 同一个 Promise。

---

## createResolveOnce：竞争的仲裁者

竞争的核心工具是 `createResolveOnce`，定义在 [src/hooks/toolPermission/PermissionContext.ts](../src/hooks/toolPermission/PermissionContext.ts#L75-L94)：

**文件：[src/hooks/toolPermission/PermissionContext.ts](../src/hooks/toolPermission/PermissionContext.ts#L63-L94)**

```typescript
type ResolveOnce<T> = {
  resolve(value: T): void
  isResolved(): boolean
  /**
   * Atomically check-and-mark as resolved. Returns true if this caller
   * won the race (nobody else has resolved yet), false otherwise.
   */
  claim(): boolean
}

function createResolveOnce<T>(resolve: (value: T) => void): ResolveOnce<T> {
  let claimed = false
  let delivered = false
  return {
    resolve(value: T) {
      if (delivered) return   // 已经 deliver 过了，忽略
      delivered = true
      claimed = true
      resolve(value)          // 真正触发外层 Promise.resolve
    },
    isResolved() {
      return claimed
    },
    claim() {
      if (claimed) return false  // 已经有人 claim 了，我输了
      claimed = true             // 原子性地标记"我赢了"
      return true
    },
  }
}
```

**关键设计**：`claim()` 是"原子性地检查并标记"——在调用 `claim()` 之后、在真正 `resolve()` 之前，这个权限请求已经被标记为"已解决"。其他竞争者再调用 `claim()` 会返回 `false`。

注意 `claimed` 和 `delivered` 的区别：
- `claimed` = 某个竞争者赢了比赛（在 claim() 时设置）
- `delivered` = 结果已经被 deliver 给外层 Promise（在 resolve() 时设置）

先 `claim()` 再做一些异步操作（持久化权限规则），最后 `resolve()` 是安全的——期间其他竞争者会因为 `claim()` 返回 false 而放弃。

---

## handleInteractivePermission：搭台子，不等结果

**文件：[src/hooks/toolPermission/handlers/interactiveHandler.ts](../src/hooks/toolPermission/handlers/interactiveHandler.ts#L57-L70)**

```typescript
function handleInteractivePermission(
  params: InteractivePermissionParams,
  resolve: (decision: PermissionDecision) => void,
): void {   // ← 注意：这里不返回 Promise！
  const { ctx, description, result, ... } = params

  // createResolveOnce 包装外层 resolve
  const { resolve: resolveOnce, isResolved, claim } = createResolveOnce(resolve)
  let userInteracted = false
  // ...
```

函数签名是 `void`，它**不等待用户响应**，只是：
1. 把确认请求放入队列（触发 UI 渲染）
2. 启动各种异步竞争者

真正的 `resolve` 会在某个竞争者赢得比赛时被调用。

---

## 竞争者 1：用户 TUI 交互

**文件：[src/hooks/toolPermission/handlers/interactiveHandler.ts](../src/hooks/toolPermission/handlers/interactiveHandler.ts#L92-L232)**

```typescript
ctx.pushToQueue({
  // ...
  onAllow(updatedInput, permissionUpdates, feedback, contentBlocks) {
    if (!claim()) return  // 原子性检查：是否已经有人赢了？

    // ...
    resolveOnce(
      await ctx.handleUserAllow(
        updatedInput,
        permissionUpdates,  // 携带持久化意图（永远允许 or 本次允许）
        feedback,
        permissionPromptStartTimeMs,
        contentBlocks,
        result.decisionReason,
      ),
    )
  },

  onReject(feedback?, contentBlocks?) {
    if (!claim()) return
    // ...
    resolveOnce(ctx.cancelAndAbort(feedback, undefined, contentBlocks))
  },

  onAbort() {
    if (!claim()) return
    // ...
    resolveOnce(ctx.cancelAndAbort(undefined, true))  // isAbort=true
  },
})
```

三种用户操作：
- `onAllow`：允许（一次或永远）
- `onReject`：拒绝（可附带反馈文字）
- `onAbort`：Esc 中止

每个回调第一件事都是 `claim()`——在任何异步操作之前先"占位"。

---

## 用户允许的两条路径

`onAllow` 接收 `permissionUpdates` 参数，这决定了是"本次允许"还是"永远允许"：

**文件：[src/hooks/toolPermission/PermissionContext.ts](../src/hooks/toolPermission/PermissionContext.ts#L139-L147)**

```typescript
async persistPermissions(updates: PermissionUpdate[]) {
  if (updates.length === 0) return false  // 空数组 = 本次临时允许

  persistPermissionUpdates(updates)    // 写入磁盘（settings.json）

  const appState = toolUseContext.getAppState()
  setToolPermissionContext(
    applyPermissionUpdates(appState.toolPermissionContext, updates),
    // ↑ 同时更新运行时上下文——当前会话立即生效，不需要重启
  )

  return updates.some(update => supportsPersistence(update.destination))
  //      ↑ 是否有内容写入了磁盘？
}
```

用户点击"Allow once"：`permissionUpdates = []` → 不写磁盘，下次还会问

用户点击"Always allow git status"：
```typescript
permissionUpdates = [{
  type: 'addRules',
  destination: 'localSettings',      // 写到 .claude/settings.local.json
  rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
  behavior: 'allow',
}]
```
→ 写磁盘，下次直接放行

**默认写 `localSettings`（不提交 git）而非 `projectSettings`**：个人使用习惯不应该提交到代码库影响团队其他人。

---

## 拒绝的两种形式

**文件：[src/hooks/toolPermission/PermissionContext.ts](../src/hooks/toolPermission/PermissionContext.ts#L154-L173)**

```typescript
cancelAndAbort(
  feedback?: string,
  isAbort?: boolean,
  contentBlocks?: ContentBlockParam[],
): PermissionDecision {
  const sub = !!toolUseContext.agentId
  const baseMessage = feedback
    ? `${REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
    : REJECT_MESSAGE

  // 关键判断：是否要 abort 整个 query 循环？
  if (isAbort || (!feedback && !contentBlocks?.length && !sub)) {
    toolUseContext.abortController.abort()
    // ↑ 取消整个会话的当前查询
  }

  return { behavior: 'ask', message, contentBlocks }
  //       ↑ 注意：返回的是 ask，不是 deny！
```

返回 `{ behavior: 'ask' }` 用于携带拒绝消息——这不是"还需要问用户"，而是作为工具调用的错误结果传回给 Claude。Claude 会看到这条消息，知道"用户拒绝了"，可以调整策略。

**带反馈的拒绝 vs 无反馈的拒绝**：
- 用户输入了原因文字 → 不 abort，只返回消息，Claude 继续运行
- 用户直接点"No" → `abort()`，中止当前 query 循环
- 用户按 Esc → `isAbort=true`，强制 abort

逻辑背后的哲学：用户说"不，你搞错了，我要你做 X 不是 Y"（有反馈）→ Claude 应该看到反馈并调整；用户直接叫停（无反馈）→ 整个任务已经不想继续了。

---

## 竞争者 2：Hook 系统

在 `pushToQueue` 之后，Hook 被异步启动（[第 411 行](../src/hooks/toolPermission/handlers/interactiveHandler.ts#L410-L431)）：

**文件：[src/hooks/toolPermission/handlers/interactiveHandler.ts](../src/hooks/toolPermission/handlers/interactiveHandler.ts#L410-L430)**

```typescript
// Skip hooks if they were already awaited in the coordinator branch
if (!awaitAutomatedChecksBeforeDialog) {
  void (async () => {
    if (isResolved()) return  // 用户已经先响应了，放弃
    const hookDecision = await ctx.runHooks(
      currentAppState.toolPermissionContext.mode,
      result.suggestions,
      result.updatedInput,
      permissionPromptStartTimeMs,
    )
    if (!hookDecision || !claim()) return  // hookDecision 为 null 或输掉了竞争
    ctx.removeFromQueue()   // 把 UI 对话框从队列里移除
    resolveOnce(hookDecision)   // Hook 赢了，用 Hook 的决策
  })()
}
```

`void (async () => { ... })()`：启动一个 fire-and-forget 的异步任务，不等待它。

Hook 通过 `claim()` 竞争。如果用户先点了按钮，`claim()` 返回 false，Hook 的结果被丢弃。如果 Hook 先响应，`claim()` 成功，UI 对话框消失。

用户配置 Hook 的方式（settings.json）：
```json
{
  "hooks": {
    "PermissionRequest": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "my-security-checker.sh"
      }]
    }]
  }
}
```

Hook 脚本可以返回 allow/deny，甚至修改工具的输入参数。企业安全系统可以通过 Hook 集成自定义策略引擎。

---

## 竞争者 3：Bash 分类器（BASH_CLASSIFIER 功能开关）

在对话框显示的同时，Bash 分类器在后台异步运行（[第 433 行](../src/hooks/toolPermission/handlers/interactiveHandler.ts#L433-L477)）：

**文件：[src/hooks/toolPermission/handlers/interactiveHandler.ts](../src/hooks/toolPermission/handlers/interactiveHandler.ts#L433-L455)**

```typescript
if (
  feature('BASH_CLASSIFIER') &&
  result.pendingClassifierCheck &&
  ctx.tool.name === BASH_TOOL_NAME &&
  !awaitAutomatedChecksBeforeDialog
) {
  setClassifierChecking(ctx.toolUseID)  // UI 显示"分类器检查中"

  void executeAsyncClassifierCheck(
    result.pendingClassifierCheck,
    ctx.toolUseContext.abortController.signal,
    ctx.toolUseContext.options.isNonInteractiveSession,
    {
      shouldContinue: () => !isResolved() && !userInteracted,
      // ↑ 用户一旦开始操作，立即停止分类器
      onComplete: () => {
        clearClassifierChecking(ctx.toolUseID)
        clearClassifierIndicator()
      },
      onAllow: decisionReason => {
        if (!claim()) return  // 用户已经先响应了
        // ...
        ctx.updateQueueItem({
          classifierAutoApproved: true,  // UI 显示自动批准的视觉效果
        })
        // ... 展示过渡动画后 resolveOnce
      },
    },
  )
}
```

注意 `shouldContinue: () => !isResolved() && !userInteracted`：

- `!isResolved()`：如果已经有人赢了（用户或 Hook），停止分类器
- `!userInteracted`：如果用户**开始交互**了（按了键盘），也停止分类器

`userInteracted` 在 `onUserInteraction` 回调里被设置（[第 108 行](../src/hooks/toolPermission/handlers/interactiveHandler.ts#L108-L122)）：

```typescript
onUserInteraction() {
  // 200ms 宽限期：防止误触发
  const GRACE_PERIOD_MS = 200
  if (Date.now() - permissionPromptStartTimeMs < GRACE_PERIOD_MS) {
    return
  }
  userInteracted = true          // 用户开始交互了
  clearClassifierChecking(ctx.toolUseID)
  clearClassifierIndicator()     // 隐藏"分类器检查中"指示器
},
```

这是一个很人性化的设计：分类器在后台悄悄运行，如果用户还没开始操作就得出结论（且高置信度），直接批准，对话框消失；如果用户已经开始按键，就尊重用户的判断，停止分类器。

---

## 竞争者 4：Bridge（claude.ai 网页端）

**文件：[src/hooks/toolPermission/handlers/interactiveHandler.ts](../src/hooks/toolPermission/handlers/interactiveHandler.ts#L234-L297)**

```typescript
// Race 4: Bridge permission response from CCR (claude.ai)
if (bridgeCallbacks && bridgeRequestId) {
  bridgeCallbacks.sendRequest(
    bridgeRequestId,
    ctx.tool.name,
    displayInput,
    ctx.toolUseID,
    description,
    result.suggestions,
    result.blockedPath,
  )

  const unsubscribe = bridgeCallbacks.onResponse(
    bridgeRequestId,
    response => {
      if (!claim()) return  // Local user/hook/classifier already responded

      // ...
      if (response.behavior === 'allow') {
        resolveOnce(ctx.buildAllow(response.updatedInput ?? displayInput))
      } else {
        resolveOnce(ctx.cancelAndAbort(response.message))
      }
    },
  )
}
```

如果用户同时打开了 CLI 和 claude.ai 网页端，两边都会看到权限请求。谁先点谁赢，另一边的对话框会消失。

---

## 竞争者 5：Channel（Telegram/iMessage 等）

**文件：[src/hooks/toolPermission/handlers/interactiveHandler.ts](../src/hooks/toolPermission/handlers/interactiveHandler.ts#L316-L407)**

```typescript
if (
  (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
  channelCallbacks &&
  !ctx.tool.requiresUserInteraction?.()
) {
  // 通过 MCP notification 发送权限请求到每个活跃 channel
  for (const client of channelClients) {
    void client.client.notification({
      method: CHANNEL_PERMISSION_REQUEST_METHOD,
      params: {
        request_id: channelRequestId,
        tool_name: ctx.tool.name,
        description,
        input_preview: truncateForPreview(displayInput),
      },
    })
  }

  // 监听 channel 的回复
  const mapUnsub = channelCallbacks.onResponse(
    channelRequestId,
    response => {
      if (!claim()) return  // Another racer won
      // ...
      resolveOnce(ctx.buildAllow(displayInput))  // or cancelAndAbort
    },
  )
}
```

你可以配置 Telegram Bot，在手机上看到权限请求，回复 "yes abc123" 来允许。这个回复经过 MCP notification 传回，在 Channel 监听器里触发，参与竞争。

---

## 完整竞争图

```
权限需要确认（ask 结果）
        │
        ▼
handleInteractivePermission()
        │
        ├── pushToQueue() → UI 对话框显示 ←── 竞争者 1：用户点击
        │                                          onAllow / onReject / onAbort
        │
        ├── void async Hook 检查 ←────────────── 竞争者 2：Hook 脚本
        │
        ├── void async Bash 分类器 ←──────────── 竞争者 3：AI 分类器
        │
        ├── Bridge 订阅 ←─────────────────────── 竞争者 4：claude.ai 网页端
        │
        └── Channel 通知 + 订阅 ←──────────────── 竞争者 5：Telegram/iMessage
                │
                ▼
            谁先 claim() 成功，谁的结果生效
            其余竞争者的 claim() 返回 false，被丢弃
                │
                ▼
            resolveOnce(decision)
                │
                ▼
            外层 Promise resolved
            工具执行（或被拒绝）
```

---

## 本节小结

权限确认不是简单的"等用户点按钮"，而是五路并行的竞争：用户 TUI、Hook 系统、AI 分类器、Bridge 远程端、Channel 消息。`createResolveOnce` 的原子 `claim()` 机制确保只有一个赢家。用户的三种选择（允许一次、永远允许、拒绝）对应不同的代码路径：永远允许会写入 settings.local.json，带反馈的拒绝不终止会话，无反馈拒绝和 Esc 会 abort 当前 query。

## 前后呼应

- `persistPermissions` 写入的 `localSettings` 文件，下次启动时会被 `loadAllPermissionRulesFromDisk()` 读取，进入 **[11-2 节](./11-2-权限规则的数据结构.md)** 讲的 `ToolPermissionContext`
- 本节的 `isResolved()` 和 `claim()` 是 `createResolveOnce` 的两个方法，[PermissionContext.ts 第 75-94 行](../src/hooks/toolPermission/PermissionContext.ts#L75-L94) 是完整实现

## 下一节预告

下一节讲 `bypassPermissions` 模式——为什么叫 `dangerously`，`isBypassPermissionsModeAvailable` 字段是如何在启动时被设置的，两层 killswitch 是什么，以及五种权限模式的完整对比。

➡️ [下一节：11-6 bypassPermissions 与安全底线](./11-6-bypassPermissions与安全底线.md)
