# 17-6 Channel 系统——通过 IM 控制 Agent

## 问题：能用 Telegram 发消息控制 Claude Code 吗？

想象这样一个场景：你在外面，手机上打开 Telegram，给 Claude Code 发一条消息"帮我检查一下服务器日志"——Claude Code 在你家的电脑上运行，执行了任务，把结果发回 Telegram。

这正是 Channel 系统要实现的能力：通过 IM 平台（Telegram、飞书、Discord 等）远程控制 Claude Code。

Channel 系统建立在 MCP 协议之上——IM 平台通过一个特殊的 MCP 服务器把消息推入 Claude Code。但这里有一个严肃的安全问题：谁都能向这个 MCP 服务器发消息，Claude Code 不能无条件执行陌生人的命令。

让我们从源码里追踪完整的实现。

核心文件：
- [src/services/mcp/channelNotification.ts](../src/services/mcp/channelNotification.ts)
- [src/services/mcp/channelPermissions.ts](../src/services/mcp/channelPermissions.ts)
- [src/services/mcp/channelAllowlist.ts](../src/services/mcp/channelAllowlist.ts)

---

## 技术基础：MCP Notification

Channel 消息通过 MCP 协议的 **Notification** 机制传入。回忆一下 MCP 的消息类型：

```
Request   → 需要响应
Response  ← Request 的答复
Notification → 单向推送，不需要响应
```

Channel IM 消息就是 MCP Server 推向 Claude Code（客户端）的一个 Notification，method 名为 `notifications/claude/channel`。

**文件：[src/services/mcp/channelNotification.ts](../src/services/mcp/channelNotification.ts#L1)**

```typescript
export const ChannelMessageNotificationSchema = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({
    source: z.string(),      // 来源标识：如 "telegram:@my_bot"
    content: z.string(),     // 消息内容
    sender: z.object({
      id: z.string(),
      name: z.string().optional(),
    }).optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
})
```

这个 schema 定义了 Claude Code 期望接收的 Channel 消息格式。任何声明支持 Channel 能力的 MCP 服务器都必须发送这个格式的通知。

---

## 服务端能力声明：'claude/channel'

MCP 服务器必须先声明它支持 Channel 功能，才能向 Claude Code 发送 Channel 消息：

**文件：[src/services/mcp/channelNotification.ts](../src/services/mcp/channelNotification.ts#L1)**

```typescript
// 连接建立后检查服务器是否声明了 channel 能力
function serverHasChannelCapability(capabilities: ServerCapabilities): boolean {
  return !!capabilities?.experimental?.['claude/channel']
}
```

能力声明在 MCP 握手阶段完成——服务器在 `initialized` 响应里包含它支持的能力。`experimental` 命名空间表示这是一个实验性功能，尚未成为 MCP 标准的一部分。

---

## gateChannelServer()：六层安全门

这是 Channel 系统最重要的函数。每当一个 MCP 服务器试图注册为 Channel 服务器时，必须通过这六道关卡：

**文件：[src/services/mcp/channelNotification.ts](../src/services/mcp/channelNotification.ts#L1)**

```typescript
export function gateChannelServer(
  serverName: string,
  capabilities: ServerCapabilities,
  pluginSource: string | undefined,
): ChannelGateResult {

  // 第一关：能力检查
  // 服务器必须声明支持 channel 能力
  if (!serverHasChannelCapability(capabilities)) {
    return {
      action: 'skip',
      kind: 'capability',
      reason: '服务器未声明 claude/channel 能力',
    }
  }

  // 第二关：功能开关
  // GrowthBook feature flag: tengu_harbor
  // 这个功能还在灰度测试阶段，默认关闭
  if (!isChannelsEnabled()) {
    return {
      action: 'skip',
      kind: 'disabled',
      reason: 'Channel 功能未启用',
    }
  }

  // 第三关：OAuth 认证
  // 必须已经登录 claude.ai（有有效的 OAuth token）
  if (!getClaudeAIOAuthTokens()?.accessToken) {
    return {
      action: 'skip',
      kind: 'auth',
      reason: '未登录 claude.ai',
    }
  }

  // 第四关：团队/企业策略
  // 企业管理员可以禁用 Channel 功能
  if (!isChannelAllowedByOrgPolicy()) {
    return {
      action: 'skip',
      kind: 'org-policy',
      reason: '组织策略禁止使用 Channel',
    }
  }

  // 第五关：会话级 --channels 参数
  // 启动 Claude Code 时必须显式传入 --channels 并列出允许的服务器
  if (!isServerInSessionChannelList(serverName)) {
    return {
      action: 'skip',
      kind: 'session',
      reason: '服务器不在本次会话的 channels 列表中',
    }
  }

  // 第六关：allowlist 账本
  // 用户或管理员明确授权的服务器列表
  if (!isChannelAllowlisted({ serverName, pluginSource })) {
    return {
      action: 'skip',
      kind: 'allowlist',
      reason: '服务器未在 allowlist 中',
    }
  }

  // 六关全部通过
  return { action: 'register' }
}
```

这六层的设计体现了**防御纵深**原则：每一层都是独立的防线，即使某层被绕过，还有后续的层。

特别注意第五关和第六关的区别：
- **--channels 参数（会话级）**：每次启动 Claude Code 时临时指定，是"这次允许哪些服务器"的动态控制
- **allowlist 账本（持久化）**：持久保存在配置里，是"长期授权哪些服务器"的静态控制

---

## isChannelsEnabled()：GrowthBook 功能开关

**文件：[src/services/mcp/channelAllowlist.ts](../src/services/mcp/channelAllowlist.ts#L1)**

```typescript
export function isChannelsEnabled(): boolean {
  // 读取 GrowthBook feature flag: tengu_harbor
  // GrowthBook 是一个 feature flag 服务，Anthropic 用它做灰度发布
  return getFeatureFlag('tengu_harbor') ?? false  // 默认关闭
}
```

`tengu_harbor`（天狗港？）是这个功能在 GrowthBook 里的名字。`?? false` 表示如果 feature flag 服务不可用（比如用户离线），默认关闭——安全侧的默认值。

`isChannelAllowlisted()` 检查账本：

```typescript
export function isChannelAllowlisted({
  serverName,
  pluginSource,
}: {
  serverName: string
  pluginSource: string | undefined
}): boolean {
  const ledger = getChannelAllowlist()  // 读取 tengu_harbor_ledger feature
  if (!ledger) return false

  // 支持两种授权方式：按服务器名授权，或按插件来源授权
  return (
    ledger.allowedServers?.includes(serverName) ||
    (pluginSource !== undefined && ledger.allowedPlugins?.includes(pluginSource))
  )
}
```

账本（ledger）也来自 GrowthBook：`tengu_harbor_ledger`。这允许 Anthropic 在服务端控制哪些 Channel 服务器是被官方认可的，用户不能绕过这个检查去注册任意 Channel 服务器。

---

## wrapChannelMessage()：安全的消息包装

Channel 消息来自外部 IM 平台，内容是不受信任的。在注入到 Claude 的上下文之前，必须做安全处理：

**文件：[src/services/mcp/channelNotification.ts](../src/services/mcp/channelNotification.ts#L1)**

```typescript
export function wrapChannelMessage(
  source: string,
  content: string,
  metadata?: Record<string, unknown>,
): string {
  // 对 source 中的特殊字符做 HTML 实体转义
  // 防止注入攻击：如果 source 是 '<script>...</script>'，不能让它破坏 XML 结构
  const safeSource = escapeXmlAttr(source)
  const safeSender = metadata?.senderName ? escapeXmlAttr(String(metadata.senderName)) : undefined

  const attrs = [
    `source="${safeSource}"`,
    safeSender ? `sender="${safeSender}"` : null,
  ].filter(Boolean).join(' ')

  // 包装成 XML 标签，明确标注这是外部 channel 消息
  return `<channel ${attrs}>${content}</channel>`
}
```

包装后的消息看起来像：
```xml
<channel source="telegram:@my_bot" sender="Alice">帮我检查服务器日志</channel>
```

为什么要包装成 XML 标签？

1. **来源标注**：Claude 能从 system prompt 里识别出这条消息来自哪个 channel，给出适当的响应
2. **沙箱隔离**：即使消息内容里有类似"忽略上面的指令"这样的提示注入，XML 标签的包裹能帮助 Claude 在上下文里区分"信任的指令"和"来自外部的消息"
3. **属性转义**：`escapeXmlAttr()` 防止 source 名里的引号破坏 XML 结构

---

## 权限确认系统：shortRequestId()

当 Channel 消息请求 Claude Code 执行某个操作（比如执行命令），Claude Code 不能自动批准——需要用户确认。

但用户在 IM 里怎么回复？直接打"yes"不够，因为可能有多个并发请求。需要一个唯一 ID 来关联请求和回复。

**文件：[src/services/mcp/channelPermissions.ts](../src/services/mcp/channelPermissions.ts#L1)**

```typescript
// 字母表：25个字母（去掉了 'l'，避免和 '1' 混淆）
const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'

// 要避免的子字符串：涉及冒犯性词汇、品牌词等
const ID_AVOID_SUBSTRINGS: string[] = [
  // ... 25 个被屏蔽的子字符串
]

function hashToId(input: string): string {
  // FNV-1a 哈希算法：简单快速的非加密哈希
  let h = 0x811c9dc5           // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)   // XOR with byte
    h = Math.imul(h, 0x01000193)  // Multiply by FNV prime
  }
  h = h >>> 0  // 转换为无符号 32 位整数

  // 把哈希值转换为 5 位 base-25 字符串
  let s = ''
  for (let i = 0; i < 5; i++) {
    s += ID_ALPHABET[h % 25]
    h = Math.floor(h / 25)
  }
  return s
}

export function shortRequestId(requestContent: string): string {
  let id = hashToId(requestContent)

  // 检查是否包含被屏蔽的子字符串
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!ID_AVOID_SUBSTRINGS.some(sub => id.includes(sub))) {
      return id  // 安全的 ID
    }
    // 加盐重新哈希，最多尝试 10 次
    id = hashToId(id + attempt.toString())
  }

  return id  // 10 次后放弃，返回最后一次的结果
}
```

**FNV-1a（Fowler-Noll-Vo）** 是一个非常轻量的哈希算法，适合生成短 ID。它的特性：
- 快速：只有 XOR 和乘法
- 均匀分布：不同输入产生不同输出的概率高
- 不是加密安全的，但这里不需要加密安全

结果是一个 5 字符的全小写 ID，如 `xkpqn`。25^5 = 9765625 种可能，对于并发请求来说足够唯一。

---

## PERMISSION_REPLY_RE：解析 IM 的回复格式

用户在 IM 里回复权限请求时，必须用规定的格式：

**文件：[src/services/mcp/channelPermissions.ts](../src/services/mcp/channelPermissions.ts#L1)**

```typescript
// 匹配格式：(y/yes/n/no) + 空格 + 5字符ID
// 示例："y xkpqn" 或 "yes xkpqn" 或 "no xkpqn"
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
```

注意正则里的字符集：`[a-km-z]`，这正好是 `ID_ALPHABET`（a-z 去掉 l）。如果用户打了 `y xklqn`（包含 l），正则不会匹配——这种设计防止用户误输入 l 和 1 混淆的 ID。

用法：
```
Claude Code 发送权限请求：
"Claude 想执行 rm -rf /tmp/old 请回复: y xkpqn 批准或 n xkpqn 拒绝"

用户回复："y xkpqn"
```

---

## truncateForPreview()：手机屏幕友好

权限请求要在手机 IM 上显示，屏幕空间有限：

**文件：[src/services/mcp/channelPermissions.ts](../src/services/mcp/channelPermissions.ts#L1)**

```typescript
const PREVIEW_MAX_LENGTH = 200

export function truncateForPreview(content: string): string {
  if (content.length <= PREVIEW_MAX_LENGTH) return content
  return content.slice(0, PREVIEW_MAX_LENGTH) + '...'
}
```

200 字符的限制。如果要执行的命令很长（比如一段复杂的 shell 脚本），只展示前 200 字符。这是可用性和安全性的平衡——用户能看到关键信息，但不会被几千字符的完整内容淹没。

---

## createChannelPermissionCallbacks()：闭包管理并发请求

当有多个并发的权限请求在等待用户确认时，需要管理"哪个回复对应哪个请求"：

**文件：[src/services/mcp/channelPermissions.ts](../src/services/mcp/channelPermissions.ts#L1)**

```typescript
export function createChannelPermissionCallbacks() {
  // 闭包内的 Map：requestId → { resolve, reject }
  const pendingRequests = new Map<string, {
    resolve: (approved: boolean) => void,
    reject: (error: Error) => void,
  }>()

  return {
    // 注册一个新的权限请求，返回一个 Promise
    register(requestId: string): Promise<boolean> {
      return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject })
      })
    },

    // 当用户回复时调用
    resolve(requestId: string, approved: boolean): boolean {
      const handlers = pendingRequests.get(requestId)
      if (!handlers) return false  // 未知 ID，忽略

      // 先从 Map 删除，再 resolve——防止重复处理
      pendingRequests.delete(requestId)
      handlers.resolve(approved)
      return true
    },

    // 超时或取消时调用
    reject(requestId: string, error: Error): boolean {
      const handlers = pendingRequests.get(requestId)
      if (!handlers) return false
      pendingRequests.delete(requestId)
      handlers.reject(error)
      return true
    },
  }
}
```

这是经典的 Promise 化异步等待模式，配合闭包实现对多个并发请求的管理。每个请求有唯一 ID，用户回复时通过 ID 找到对应的 Promise 并 resolve 或 reject。

---

## 完整的 Channel 消息流

```
IM 用户发送消息 "帮我检查 /var/log/nginx/error.log"
        │
        ▼
Channel MCP Server（如 Telegram adapter）
接收到消息，发送 MCP Notification：
  { method: "notifications/claude/channel", params: { source: "telegram", content: "..." } }
        │
        ▼
Claude Code 接收到 Notification
        │
        ▼
gateChannelServer() 六层检查
  ✓ 服务器声明了 claude/channel 能力
  ✓ tengu_harbor 功能已开启
  ✓ 用户已登录 claude.ai
  ✓ 组织策略允许
  ✓ 服务器在 --channels 列表中
  ✓ 服务器在 allowlist 账本中
        │ 全部通过
        ▼
wrapChannelMessage() 包装消息：
  <channel source="telegram" sender="Alice">帮我检查 /var/log/nginx/error.log</channel>
        │
        ▼
注入到 Claude 的上下文
        │
        ▼
Claude 决定调用 Read 工具读取日志
        │ 需要权限确认
        ▼
shortRequestId("Read /var/log/nginx/error.log") → "xkpqn"
        │
        ▼
Channel 回发权限请求：
  "Claude 想读取 /var/log/nginx/error.log
   回复: y xkpqn 批准 或 n xkpqn 拒绝"
        │
        ▼
IM 用户回复："y xkpqn"
        │
        ▼
PERMISSION_REPLY_RE 匹配，解析出 approved=true, id="xkpqn"
        │
        ▼
createChannelPermissionCallbacks().resolve("xkpqn", true)
        │
        ▼
Claude Code 执行 Read，结果发回 IM
```

---

## 本章小结

Channel 系统是 MCP 协议的一个巧妙扩展应用：

1. **MCP Notification 作为消息信道**：IM 消息通过 `notifications/claude/channel` 推入，复用了已有的 MCP 连接
2. **六层安全门**：能力声明 → 功能开关 → OAuth → 组织策略 → 会话参数 → allowlist 账本，防御纵深
3. **XML 包装沙箱**：来自 IM 的消息被包裹在 `<channel>` 标签里，Claude 能区分受信任的系统指令和外部消息
4. **FNV-1a 短 ID**：5 字符的确认码，手机友好，字母表排除易混淆字符
5. **闭包管理并发**：`createChannelPermissionCallbacks()` 用闭包 Map 管理多个并发权限等待

## 前后引路

- Channel 权限系统是普通权限系统（第 11 章）在 IM 场景的特化版本

## 第 17 章总结

第 17 章覆盖了 Claude Code 与外部世界连接的三个主要机制：

| 系统 | 技术基础 | 核心问题 |
|------|----------|----------|
| MCP（17-1 到 17-3）| JSON-RPC 2.0 + 多传输层 | 如何标准化接入任意外部工具 |
| 插件系统（17-4）| 分层配置 + 去重策略 | 谁来管理 MCP 服务器的生命周期 |
| 远程会话（17-5）| WSS 主动连接 + 心跳重连 | 本地 CLI 如何被远程浏览器控制 |
| Channel 系统（17-6）| MCP Notification + 六层门控 | IM 消息如何安全地注入 Claude 上下文 |

---

## 下一章预告

第 18 章是整个课程的终章：**从零实现**。

我们把整个课程学到的所有概念串联起来，用 9 节课从 50 行代码开始，一步步构建出一个完整的 LLM CLI 工具——不是重复 Claude Code 的代码，而是理解它的设计思路后，用自己的理解重新建造。

➡️ [进入第 18 章：18-1 先设计再实现——画出系统草图](./18-1-先设计再实现画出系统草图.md)
