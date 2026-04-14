# 11-6 bypassPermissions 与安全底线

> `--dangerously-skip-permissions` 的 `dangerously` 不是摆设。本节追踪这个功能的完整实现：`isBypassPermissionsModeAvailable` 字段如何在启动时被设置，两层 killswitch 如何工作，以及为什么即使开了 YOLO 模式，某些操作还是无法跳过。

---

## 问题引入：谁决定了 bypass 能不能用

七步流水线里 Step 2a 的代码是（[permissions.ts 第 1268-1281 行](../src/utils/permissions/permissions.ts#L1268-L1281)）：

```typescript
const shouldBypassPermissions =
  appState.toolPermissionContext.mode === 'bypassPermissions' ||
  (appState.toolPermissionContext.mode === 'plan' &&
    appState.toolPermissionContext.isBypassPermissionsModeAvailable)
```

它检查 `mode` 是否是 `bypassPermissions`，以及 `isBypassPermissionsModeAvailable` 字段。

这两个信息从哪里来？为什么不直接检查 `--dangerously-skip-permissions` flag，而要绕一层字段？

答案是：**`isBypassPermissionsModeAvailable` 是在启动时计算并存储的，之后不可更改**。这是一个刻意的设计——防止运行时升级权限。

---

## isBypassPermissionsModeAvailable 在哪里被设置

打开 [src/utils/permissions/permissionSetup.ts](../src/utils/permissions/permissionSetup.ts#L930-L943)，找到初始化函数里的计算：

**文件：[src/utils/permissions/permissionSetup.ts](../src/utils/permissions/permissionSetup.ts#L930-L943)**

```typescript
// Check if bypassPermissions mode is available (not disabled by Statsig gate or settings)
// Use cached values to avoid blocking on startup
const growthBookDisableBypassPermissionsMode =
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
    'tengu_disable_bypass_permissions_mode',
  )
const settings = getSettings_DEPRECATED() || {}
const settingsDisableBypassPermissionsMode =
  settings.permissions?.disableBypassPermissionsMode === 'disable'

const isBypassPermissionsModeAvailable =
  (permissionMode === 'bypassPermissions' ||
    allowDangerouslySkipPermissions) &&    // 用户明确传了 flag
  !growthBookDisableBypassPermissionsMode &&  // Statsig 没有远程禁用
  !settingsDisableBypassPermissionsMode      // 企业设置没有禁用
```

三个条件必须同时满足：
1. **用户明确声明**：`permissionMode === 'bypassPermissions'` 或 `allowDangerouslySkipPermissions`（`--dangerously-skip-permissions` flag）
2. **Statsig 没有远程禁用**：`checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_disable_bypass_permissions_mode')`
3. **企业设置没有禁用**：`settings.permissions?.disableBypassPermissionsMode !== 'disable'`

---

## 为什么需要"启动时计算并冻结"

如果每次 Step 2a 都实时检查 `--dangerously-skip-permissions` flag，会怎样？

问题：运行时可以通过修改某个全局变量来"升级"自己的权限。Claude 如果被恶意内容欺骗，可能尝试"给自己授权"。

**`isBypassPermissionsModeAvailable` 被冻结在 `ToolPermissionContext`（readonly 字段）里，启动后不可修改**。这是一个不可变对象——你可以创建新的 `ToolPermissionContext`，但无法改变已有的那个。

看类型定义（[src/types/permissions.ts 第 427-441 行](../src/types/permissions.ts#L427-L441)）：

```typescript
export type ToolPermissionContext = {
  readonly mode: PermissionMode
  // ...
  readonly isBypassPermissionsModeAvailable: boolean
  // ↑ readonly：创建后不可变
}
```

这个字段只有在 `permissionSetup.ts` 的初始化函数里被设置一次，之后只能通过创建新对象来"更改"（但新对象必须经过同样的检查，所以没法绕过）。

---

## 两层 killswitch

即使用户传了 `--dangerously-skip-permissions`，管理员也可以通过两层机制禁用它：

### 层 1：Statsig/GrowthBook 远程功能开关

```typescript
const growthBookDisableBypassPermissionsMode =
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
    'tengu_disable_bypass_permissions_mode',  // ← 功能开关名称
  )
```

Anthropic 控制的功能开关。如果检测到某种滥用模式，可以全局禁用 bypass 模式——所有用户的所有会话都立即受影响（下次启动时生效）。

注意 `_CACHED_MAY_BE_STALE`——这是缓存的读取，可能有延迟。但对于启动时的安全检查，读取已缓存的值（避免阻塞启动）是合理的权衡。

### 层 2：企业 policySettings

**文件：[src/utils/permissions/permissionSetup.ts](../src/utils/permissions/permissionSetup.ts#L704-L711)**

```typescript
// Check settings - lower precedence than Statsig
const settingsDisableBypassPermissionsMode =
  settings.permissions?.disableBypassPermissionsMode === 'disable'

// Statsig gate takes precedence over settings
const disableBypassPermissionsMode =
  growthBookDisableBypassPermissionsMode ||
  settingsDisableBypassPermissionsMode
```

企业管理员可以在 policy settings（最高优先级的设置文件）里配置：

```json
{
  "permissions": {
    "disableBypassPermissionsMode": "disable"
  }
}
```

Policy settings 是企业托管部署时由管理员控制的只读设置，优先级最高（见 11-2 节的来源优先级表）。用户无法覆盖它。

---

## Plan 模式的 bypass 继承

Step 2a 的判断（[permissions.ts 第 1268-1271 行](../src/utils/permissions/permissions.ts#L1268-L1271)）：

```typescript
const shouldBypassPermissions =
  appState.toolPermissionContext.mode === 'bypassPermissions' ||
  (appState.toolPermissionContext.mode === 'plan' &&
    appState.toolPermissionContext.isBypassPermissionsModeAvailable)
```

如果用户用 `--dangerously-skip-permissions` 启动，然后切换到 Plan 模式（`/plan`），工具执行依然保持 bypass 行为。

**为什么这样设计？**

Plan 模式通常是"只规划不执行"，但当用户从 bypass 模式切换过来时，他们的意图是"继续享受 bypass 便利，只是想看看计划"。如果切换到 Plan 后 bypass 失效，用户会困惑：明明开了 YOLO 模式，怎么突然开始弹框了？

`isBypassPermissionsModeAvailable` 作为"这个会话原本有 bypass 资格"的标志，确保切换 Plan 模式不会意外丢失 bypass 行为。

---

## bypass 绕不过的四道关卡（回顾 Steps 1d-1g）

即使开了 bypass 模式，以下情况在 Step 2a 之前已经返回了，bypass 无法介入：

```
Step 1d：工具自己说 deny
  示例：BashTool 对 "rm -rf /" 返回 deny
  → bypass 无法绕过工具的明确拒绝

Step 1e：工具必须弹框（requiresUserInteraction = true）
  示例：AskUserQuestion 工具，本质需要用户参与
  → bypass 无法把这类工具变成自动执行

Step 1f：用户配了内容级 ask 规则
  示例：用户配了 Bash(npm publish:*) → ask
  → 用户明确要每次确认，bypass 必须尊重这个意愿

Step 1g：安全路径检查（safetyCheck）
  示例：修改 .claude/settings.json
  → 这类操作若被提示词注入利用可能永久改变 Claude 行为
  → 无论如何必须确认
```

Step 1g 的 `safetyCheck` 还有一个字段 `classifierApprovable`（[src/types/permissions.ts 第 313-320 行](../src/types/permissions.ts#L313-L320)）：

```typescript
| {
    type: 'safetyCheck'
    reason: string
    classifierApprovable: boolean  // AI 分类器能否代替人工确认？
  }
```

当 `classifierApprovable = true` 时（如敏感文件路径），AI 分类器可以在 auto 模式下代替人工确认。当 `classifierApprovable = false` 时（如 Windows 路径绕过尝试），必须人工确认，分类器也不行。

---

## 五种权限模式的完整代码位置

所有模式定义在 [src/types/permissions.ts 第 16-36 行](../src/types/permissions.ts#L16-L36)：

**文件：[src/types/permissions.ts](../src/types/permissions.ts#L16-L36)**

```typescript
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',       // 自动接受文件编辑，Bash 仍需确认
  'bypassPermissions', // 跳过几乎所有权限检查
  'default',           // 默认，未配置的操作需要确认
  'dontAsk',           // 所有 ask 直接变 deny
  'plan',              // 计划模式，不执行工具（只读）
] as const

export const INTERNAL_PERMISSION_MODES = [
  ...EXTERNAL_PERMISSION_MODES,
  ...(feature('TRANSCRIPT_CLASSIFIER') ? (['auto'] as const) : ([] as const)),
  // ↑ auto 模式：ANT-ONLY，用 AI 分类器替代人工确认
] as const
```

`auto` 模式不在 `EXTERNAL_PERMISSION_MODES` 里——它是内部功能，通过功能开关控制。

各模式在代码里的处理位置：

| 模式 | 处理位置 | 逻辑 |
|------|---------|------|
| `default` | 七步流水线 Step 3 | passthrough → ask → 弹框 |
| `acceptEdits` | 各文件工具的 `checkPermissions()` | 文件工具返回 allow，Bash 仍 passthrough |
| `bypassPermissions` | 七步流水线 Step 2a | 直接返回 allow |
| `dontAsk` | `hasPermissionsToUseTool` 外层第 508 行 | ask → deny |
| `plan` | 各工具实现 | 只允许只读操作 |
| `auto` | `hasPermissionsToUseTool` 外层第 520 行 | ask → AI 分类器判断 |

---

## acceptEdits 模式的实现：在工具内部处理

`acceptEdits` 不是在流水线里处理的，而是在每个文件工具的 `checkPermissions()` 里：

```typescript
// WriteFileTool.checkPermissions()（简化）
async checkPermissions(input, context) {
  const appState = context.getAppState()

  if (appState.toolPermissionContext.mode === 'acceptEdits') {
    return {
      behavior: 'allow',
      decisionReason: { type: 'mode', mode: 'acceptEdits' }
    }
    // ↑ 在 Step 1c 直接返回 allow，甚至跳过了后续的路径检查
  }
  // ... 其他检查
}
```

**注意**：`acceptEdits` 的 allow 返回不是 passthrough，所以它会流经 Step 1d-1g 的检查。安全路径（Step 1g）仍然有效——即使在 `acceptEdits` 模式下，修改 `.claude/settings.json` 也会弹框。

---

## dontAsk 模式：外层把 ask 变成 deny

**文件：[src/utils/permissions/permissions.ts](../src/utils/permissions/permissions.ts#L503-L516)**

```typescript
// Apply dontAsk mode transformation: convert 'ask' to 'deny'
// This is done at the end so it can't be bypassed by early returns
if (result.behavior === 'ask') {
  const appState = context.getAppState()

  if (appState.toolPermissionContext.mode === 'dontAsk') {
    return {
      behavior: 'deny',
      decisionReason: {
        type: 'mode',
        mode: 'dontAsk',
      },
      message: DONT_ASK_REJECT_MESSAGE(tool.name),
    }
  }
```

注释说明了为什么放在外层末尾（`// This is done at the end so it can't be bypassed by early returns`）：如果放在内层（`hasPermissionsToUseToolInner`），有些早期返回的路径可能会绕过它。放在外层确保所有 ask 都被转换。

---

## 完整的模式选择流程图

```
用户启动 claude --dangerously-skip-permissions
        │
        ▼
initialPermissionModeFromCLI()          ← permissionSetup.ts:689
  检查 Statsig killswitch
  检查企业 policySettings
        │
        ▼
isBypassPermissionsModeAvailable = true/false
        │
        ▼
ToolPermissionContext = {
  mode: 'bypassPermissions',
  isBypassPermissionsModeAvailable: true,
  alwaysAllowRules: ...,
  ...
}（readonly，冻结）
        │
        ▼
会话期间每次工具调用：
hasPermissionsToUseToolInner()
  Step 1a: deny 规则？→ 无
  Step 1b: ask 规则？→ 无
  Step 1c: tool.checkPermissions() → passthrough
  Step 1d-1g: 安全检查 → 全部通过
  Step 2a: mode === 'bypassPermissions'？→ 是 → return allow ✓
```

---

## 本节小结

`isBypassPermissionsModeAvailable` 是在启动时计算并冻结的不可变字段，由三个条件共同决定：用户 flag + Statsig 远程开关 + 企业设置。两层 killswitch 让管理员能在任何级别禁用 YOLO 模式。即使开了 bypass，Steps 1d-1g 的四道关卡仍然有效——工具明确拒绝、必须弹框的工具、用户的 ask 规则、安全路径检查，任何一个都能阻止 bypass。

## 前后呼应

- 本节反复用到的 `ToolPermissionContext` 结构，在 **[11-2 节](./11-2-权限规则的数据结构.md)** 有详细定义
- Steps 1d-1g 的 bypass 免疫区，在 **[11-3 节](./11-3-七步流水线逐行追踪.md)** 已经完整追踪过代码

## 下一节预告

第 11 章结束了。下一章我们转向另一个核心子系统：**状态管理与 TUI 渲染**。Claude Code 的整个 TUI 界面状态，是如何从一个单一数据源流出来的？

➡️ [下一章：12-1 AppState——整个 TUI 的单一数据源](./12-1-AppState整个TUI的单一数据源.md)
