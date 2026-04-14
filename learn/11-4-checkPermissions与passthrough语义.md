# 11-4 checkPermissions 与 passthrough 语义

> 七步流水线的 Step 1c 把决策权委托给工具自己的 `checkPermissions()`。这一步做了什么？BashTool 如何用"前缀匹配"来检查命令？`passthrough` 到底是什么意思？

---

## 问题引入：谁来判断"这个命令该不该允许"

在七步流水线里，Steps 1a/1b 只看整个工具是否被 deny/ask，粒度很粗。

但权限系统需要更细的粒度：

- `Bash(npm install)` 应该允许
- `Bash(npm publish)` 应该询问
- `Bash(rm -rf)` 应该拒绝

这些都是 Bash 工具，但内容不同，决策不同。谁来做这个内容级的判断？

答案是：**交给工具自己的 `checkPermissions()` 方法**。

---

## 朴素方案：在中心把所有规则都处理掉

最直觉的设计是：在 `hasPermissionsToUseToolInner` 里把所有内容级规则也一并处理，不让工具参与决策。

问题：每个工具的"内容"格式完全不同：
- BashTool 的内容是命令字符串，需要前缀匹配
- WriteFileTool 的内容是文件路径，需要目录匹配
- 未来的 MCP 工具，内容可能是 JSON 参数

如果放在中心处理，核心权限逻辑要理解所有工具的内容格式——这违反了开闭原则。

**解法：每个工具实现自己的 `checkPermissions()`**，核心只调用它。

---

## checkPermissions 的接口契约

每个工具实现这个接口（在 `Tool.ts` 里定义）：

```typescript
checkPermissions(
  input: ParsedInput,
  context: ToolUseContext
): Promise<PermissionResult>
```

返回值 `PermissionResult` 比 `PermissionDecision` 多一个值：

**文件：[src/types/permissions.ts](../src/types/permissions.ts#L251-L266)**

```typescript
export type PermissionResult<Input> =
  | PermissionDecision<Input>       // allow / ask / deny（与 PermissionDecision 相同）
  | {
      behavior: 'passthrough'       // 新增：工具说"我不知道，你来定"
      message: string
      decisionReason?: ...
    }
```

`passthrough` 是工具专用的"弃权"信号。它的语义是：**当前规则集没有命中这个命令，我无法给出明确答案**。

这不同于 `ask`：`ask` 是工具主动说"这个操作需要确认"；`passthrough` 是工具说"规则里没提到这个，我不知道"。

---

## BashTool 的 checkPermissions 调用链

BashTool 的权限检查相当复杂，但有一条主干路径：

```
bashToolHasPermission()                     ← bashPermissions.ts:1663
  │
  ├── AST 安全解析（tree-sitter，实验性）
  │
  ├── bashToolCheckExactMatchPermission()   ← 精确匹配
  │       └── 检查命令是否和规则完全相同
  │
  ├── checkPathConstraints()               ← 路径安全检查
  │       └── 文件路径是否在允许目录内
  │
  ├── bashToolCheckCommandOperatorPermissions()  ← 复合命令处理
  │       └── cmd1 && cmd2 这类情况
  │
  └── bashToolCheckSubcommandPermissions()  ← 前缀匹配（最常用路径）
          └── 命令前缀是否在规则里
```

我们重点看最常用的精确匹配函数，它展示了 `passthrough` 的用法：

---

## 精确匹配：四步决策

**文件：[src/tools/BashTool/bashPermissions.ts](../src/tools/BashTool/bashPermissions.ts#L991-L1042)**

```typescript
export const bashToolCheckExactMatchPermission = (
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult => {
  const command = input.command.trim()
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'exact')
    // ↑ 分别找出匹配该命令的 deny/ask/allow 规则

  // 1. 精确 deny → 立即拒绝
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
      decisionReason: { type: 'rule', rule: matchingDenyRules[0] },
    }
  }

  // 2. 精确 ask → 要求确认
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: { type: 'rule', rule: matchingAskRules[0] },
    }
  }

  // 3. 精确 allow → 直接允许
  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'rule', rule: matchingAllowRules[0] },
    }
  }

  // 4. 没有规则匹配 → passthrough（弃权）
  const decisionReason = {
    type: 'other' as const,
    reason: 'This command requires approval',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    ...
  }
}
```

最后一步（第 1035 行的注释 `// 4. Otherwise, passthrough`）是关键：**没有任何规则命中时，工具不做判断，交回给流水线**。

这与直接返回 `ask` 截然不同。如果这里返回 `ask`，流水线里的 Step 2a（bypass 模式）就无效了——bypass 模式发生在 `ask` 经过 1d-1g 检查之后。但 `passthrough` 会在流水线的 Step 3 被转为 `ask`，**这个转换发生在 bypass 检查（Step 2a）之后**。

---

## passthrough 的真正作用

让我们看这两种场景的路径对比：

**场景 A：工具返回 `ask`（主动要求确认）**

```
BashTool.checkPermissions → { behavior: 'ask', decisionReason: { type: 'rule', ... } }

流水线 Step 1d：behavior 不是 deny → 继续
流水线 Step 1e：requiresUserInteraction = false → 继续
流水线 Step 1f：decisionReason.rule.ruleBehavior === 'ask' → ✓ 返回 ask
                                                          ↑ bypass 免疫！
```

**场景 B：工具返回 `passthrough`（无意见）**

```
BashTool.checkPermissions → { behavior: 'passthrough' }

流水线 Step 1d：behavior 不是 deny → 继续
流水线 Step 1e：requiresUserInteraction = false → 继续
流水线 Step 1f：decisionReason 不是 type:'rule' → 继续
流水线 Step 1g：decisionReason 不是 'safetyCheck' → 继续

流水线 Step 2a：bypassPermissions？
  → 是：返回 allow（bypass 生效！）
  → 否：继续

流水线 Step 2b：全局 allow 规则？→ 检查...

流水线 Step 3：passthrough → ask
```

**结论**：`passthrough` 让 bypass 模式有机会介入。`ask`（带 `type:'rule'` 的 decisionReason）是 bypass 免疫的，但 `passthrough` 不是。

这个语义区分非常重要：**工具主动要求确认 vs 工具不知道**，得到的处理方式完全不同。

---

## 前缀匹配的安全细节

`Bash(npm install)` 这条规则，实际上是一个前缀规则——它匹配所有以 `npm install` 开头的命令，包括 `npm install react`、`npm install --save-dev typescript` 等。

但这里有个安全问题：如果规则是 `Bash(npm:*)` 允许所有 npm 命令，能不能通过 `npm install && rm -rf /` 来绕过？

代码的处理：

**文件：[src/tools/BashTool/bashPermissions.ts](../src/tools/BashTool/bashPermissions.ts#L862-L899)**

```typescript
// SECURITY: Don't allow prefix rules to match compound commands.
// 前缀规则不能匹配复合命令（包含 && || ; 等操作符的命令）
if (matchMode === 'prefix' && !skipCompoundCheck) {
  // ...
  case 'prefix': {
    // 如果命令是复合命令，前缀规则不匹配
    if (isCompoundCommand.get(cmdToMatch)) {
      return false
    }
    // 单命令：检查前缀匹配 + 单词边界
    if (cmdToMatch === bashRule.prefix) return true
    if (cmdToMatch.startsWith(bashRule.prefix + ' ')) return true
    return false
  }
```

即使你有 `Bash(npm:*)` 规则，`npm install && rm -rf /` 也不会被放行——因为它是复合命令（包含 `&&`），前缀规则不匹配复合命令。

同时，还有 `stripAllEnvVars` 选项（[第 826 行](../src/tools/BashTool/bashPermissions.ts#L826)），对 deny 规则会剥掉所有环境变量前缀：`FOO=bar denied_command` 里的 `denied_command` 依然会被拒绝，不能通过加环境变量前缀来绕过黑名单。

---

## WriteFileTool 的 checkPermissions：另一种风格

不同的工具有完全不同的实现风格。WriteFileTool 关心的是路径，而不是命令前缀：

```typescript
// src/tools/WriteFileTool.ts（简化）
async checkPermissions(input, context) {
  const { file_path } = input
  const appState = context.getAppState()

  // 检查路径是否在工作目录内
  const pathResult = checkPathConstraints(file_path, appState.toolPermissionContext)
  if (pathResult.behavior !== 'passthrough') {
    return pathResult  // 路径被拒绝或需要确认
  }

  // 检查是否是敏感路径（.git/, .claude/ 等）
  const safetyResult = checkPathSafetyForAutoEdit(file_path, appState.toolPermissionContext)
  if (safetyResult.behavior !== 'passthrough') {
    return safetyResult  // { behavior: 'ask', decisionReason: { type: 'safetyCheck' } }
  }

  // acceptEdits 模式：自动允许文件写入
  if (appState.toolPermissionContext.mode === 'acceptEdits') {
    return { behavior: 'allow', ... }
  }

  return { behavior: 'passthrough', ... }  // 没有明确意见，交给流水线
}
```

注意 `safetyCheck` 的 `decisionReason`——这正是 Step 1g bypass 免疫的原因：WriteFileTool 对敏感路径返回 `{ type: 'safetyCheck' }`，流水线在 Step 1g 直接返回，不让 bypass 模式介入。

---

## 各工具的 passthrough 路径总结

```
工具.checkPermissions()
        │
        ├── 找到 deny 规则 → return { behavior: 'deny' }
        │       └── 流水线 Step 1d 直接返回
        │
        ├── 找到 ask 规则 → return { behavior: 'ask', decisionReason: {type:'rule', ruleBehavior:'ask'} }
        │       └── 流水线 Step 1f bypass 免疫
        │
        ├── 找到 allow 规则 → return { behavior: 'allow' }
        │       └── 流水线跳过 bypass 检查，直接允许
        │
        ├── 安全路径问题 → return { behavior: 'ask', decisionReason: {type:'safetyCheck'} }
        │       └── 流水线 Step 1g bypass 免疫
        │
        └── 没有规则命中 → return { behavior: 'passthrough' }
                └── 流水线继续：检查 bypass → 检查 allow 规则 → 转为 ask
```

---

## 本节小结

`checkPermissions()` 是工具的自治权——每个工具用自己最懂的方式检查内容级权限。BashTool 用前缀匹配检查命令字符串，WriteFileTool 用目录检查文件路径。`passthrough` 是精心设计的"弃权"语义：没有规则命中时，工具不强行给答案，让外层流水线继续判断，从而让 bypass 模式有机会生效。

## 前后呼应

- 本节的 `safetyCheck` 返回值，是流水线 Step 1g bypass 免疫的关键，在 **[11-3 节](./11-3-七步流水线逐行追踪.md)** 已经讲了"为什么免疫"，本节讲了"谁触发了它"
- `acceptEdits` 模式（WriteFileTool 里提到的那个）属于 **[11-6 节](./11-6-bypassPermissions与安全底线.md)** 讲的五种权限模式之一

## 下一节预告

流水线的最终结果是 `ask`——用户会看到一个确认对话框。下一节看这个对话框背后的代码：多路竞争机制（用户、Hook、AI 分类器同时等待），以及用户选择"允许/永远允许/拒绝"时，代码走的是哪条路径。

➡️ [下一节：11-5 用户响应与 Race 竞争机制](./11-5-用户响应与Race竞争机制.md)
