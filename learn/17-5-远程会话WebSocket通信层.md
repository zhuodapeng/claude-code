# 17-5 远程会话 WebSocket 通信层

## 问题：怎么从浏览器控制本地的 Claude Code？

Claude Code 是一个运行在本地终端的 CLI 工具。但 claude.ai 提供了一种功能：在浏览器界面里直接控制本地的 Claude Code——你的 Claude Code 在本地运行，但你可以在任意设备的浏览器上查看输出、发送指令，甚至多人同时观看同一个 Claude Code 会话。

这需要一条从 claude.ai → 本地 Claude Code 的通信信道。

这条信道是怎么建立的？安全性怎么保障？断线了怎么重连？

核心文件：[src/remote/SessionsWebSocket.ts](../src/remote/SessionsWebSocket.ts)

---

## 架构概览：谁连接谁

先理解这个系统的拓扑结构，因为它和直觉可能相反：

```
本地 Claude Code                    Anthropic 服务器                    浏览器 (claude.ai)
       │                                   │                                   │
       │──── WebSocket 连接 (WSS) ────────►│◄──── HTTP/WebSocket ──────────────│
       │  Claude Code 主动连接服务器        │   浏览器连接同一个 session         │
       │                                   │                                   │
       │◄─── 事件推送（用户消息）───────────│                                   │
       │──── 结果上报（工具执行结果）───────►│──── 展示给浏览器 ─────────────────►│
```

**关键点**：Claude Code 是**主动连接**到 Anthropic 服务器的，而不是等待服务器来连接它。这解决了本地机器没有公网 IP 的问题——本地机器主动建立 WebSocket 连接，服务器通过这条连接向本地推送消息。

这和 Telegram Bot 的设计是同一个思路：bot 轮询服务器而不是等服务器推送。只不过这里用的是 WebSocket 的长连接而不是轮询。

---

## WebSocket URL 的构成

**文件：[src/remote/SessionsWebSocket.ts](../src/remote/SessionsWebSocket.ts#L1)**

```typescript
const wsUrl = `wss://api.anthropic.com/v1/sessions/ws/${sessionId}/subscribe?organization_uuid=${orgUuid}`
```

URL 里有两个关键参数：
- `sessionId`：这个 Claude Code 会话的唯一 ID，浏览器端通过同一个 session ID 关联到这个会话
- `organization_uuid`：用户所属组织的 UUID，用于鉴权和多租户隔离

`/subscribe` 路径暗示了这是一个订阅连接——Claude Code 订阅这个 session 的事件流。

---

## 认证：WebSocket Header 里的 Bearer Token

WebSocket 连接建立时，Claude Code 需要向服务器证明身份。标准的 WebSocket 浏览器 API 不支持自定义 header（历史遗留问题），但 Node.js/Bun 的 WebSocket 实现可以。

**文件：[src/remote/SessionsWebSocket.ts](../src/remote/SessionsWebSocket.ts#L1)**

```typescript
// Bun 环境：使用 globalThis.WebSocket（Bun 内置）
if (typeof globalThis.WebSocket !== 'undefined' && isBunEnvironment()) {
  this.ws = new globalThis.WebSocket(wsUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
    },
    // 代理支持（企业环境里可能有 HTTP 代理）
    proxy: getProxyConfig(),
    tls: getTlsConfig(),
  })
}

// Node.js 环境：使用 ws 库
else {
  const { WebSocket: NodeWebSocket } = await import('ws')
  this.ws = new NodeWebSocket(wsUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
    },
    agent: getHttpAgent(),
  })
}
```

两套代码处理 Bun 和 Node.js 的差异——这两个运行时的 WebSocket API 略有不同（Bun 内置，Node.js 需要 `ws` 包，且选项的键名不同）。

`anthropic-version: 2023-06-01` 是 Anthropic API 的版本头，确保服务器用正确的 API 版本处理请求。

---

## 重连策略：5次，2秒间隔

网络是不可靠的。WebSocket 连接可能因为网络波动、服务器重启、NAT 超时等原因断开。需要自动重连。

**文件：[src/remote/SessionsWebSocket.ts](../src/remote/SessionsWebSocket.ts#L1)**

```typescript
const RECONNECT_DELAY_MS = 2000         // 重连间隔：2秒
const MAX_RECONNECT_ATTEMPTS = 5        // 最大重连次数：5次
const PING_INTERVAL_MS = 30000          // 心跳间隔：30秒
const MAX_SESSION_NOT_FOUND_RETRIES = 3 // 4001 错误的专用重试次数

// 不可恢复的错误码
const PERMANENT_CLOSE_CODES = new Set([4003])  // 4003 = 未授权
```

重连逻辑：

```typescript
private handleClose(code: number, reason: string): void {
  // 4003 = 未授权（token 无效/过期），永久停止重连
  if (PERMANENT_CLOSE_CODES.has(code)) {
    this.emit('permanent-error', { code, reason })
    return
  }

  // 4001 = session not found（可能是 session 正在压缩，短暂不可用）
  if (code === 4001) {
    if (this.sessionNotFoundRetries < MAX_SESSION_NOT_FOUND_RETRIES) {
      this.sessionNotFoundRetries++
      // 线性退避：第1次等2s，第2次等4s，第3次等6s
      const delay = RECONNECT_DELAY_MS * this.sessionNotFoundRetries
      setTimeout(() => this.connect(), delay)
      return
    }
  }

  // 正常重连
  if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    this.reconnectAttempts++
    setTimeout(() => this.connect(), RECONNECT_DELAY_MS)
  } else {
    this.emit('max-reconnect-exceeded')
  }
}
```

**4001 vs 4003 的不同处理**：

- `4003 unauthorized`：token 无效，重连没有意义，直接停止。这通常是 OAuth token 过期，需要用户重新登录。
- `4001 session-not-found`：session 找不到，可能是暂时的。源码注释说这个错误可能在 session 压缩（compaction）过程中短暂出现——压缩是指把旧消息归档，这个操作进行中时 session 短暂"消失"。用线性退避重试 3 次，压缩通常很快完成。

---

## 心跳：30秒 ping

WebSocket 连接在闲置时可能被 NAT、防火墙或负载均衡器切断，即使双方都没有主动关闭。定期发送 ping 保持连接活跃：

**文件：[src/remote/SessionsWebSocket.ts](../src/remote/SessionsWebSocket.ts#L1)**

```typescript
private startPingInterval(): void {
  this.pingInterval = setInterval(() => {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.ping()   // WebSocket 标准 ping 帧
    }
  }, PING_INTERVAL_MS)
}

private stopPingInterval(): void {
  if (this.pingInterval) {
    clearInterval(this.pingInterval)
    this.pingInterval = null
  }
}
```

30 秒是典型的选择：
- 太短（比如 5 秒）：无意义流量太多，对服务器有压力
- 太长（比如 5 分钟）：大多数 NAT 的超时是 60-120 秒，会在 ping 之前被切断

---

## RemoteSessionManager：协调 WebSocket 和 HTTP

`SessionsWebSocket` 只负责底层 WebSocket 连接。上层的 `RemoteSessionManager` 负责协调所有远程会话相关的逻辑：

**文件：[src/remote/RemoteSessionManager.ts](../src/remote/RemoteSessionManager.ts#L1)**

```typescript
class RemoteSessionManager {
  private ws: SessionsWebSocket
  private sessionId: string

  // 接收来自浏览器的消息，交给 Claude Code 处理
  async handleIncomingMessage(message: RemoteMessage): Promise<void> {
    if (message.type === 'user_message') {
      // 把远程消息注入到本地 Claude Code 的消息队列
      this.messageQueue.push(message.content)
    } else if (message.type === 'permission_response') {
      // 处理权限确认响应
      this.handlePermissionResponse(message)
    }
  }

  // 发送事件给远程端（浏览器看到的输出）
  async sendEvent(event: RemoteEvent): Promise<void> {
    await sendEventToRemoteSession(this.sessionId, event)
  }
}
```

`RemoteSessionManager` 有一个重要的 `viewerOnly` 模式：

```typescript
if (this.viewerOnly) {
  // 纯观看模式：不发送中断，不处理 60 秒超时，不更新标题
  // 用于第三方用户"旁观"另一个人的 Claude Code 会话
  return
}
```

当多个用户共享同一个 session 时，非主控用户以 viewerOnly 模式连接——他们能看到输出，但不能发送命令，不会影响会话状态。

---

## RemotePermissionResponse：远程权限确认

远程会话里，当 Claude Code 需要用户确认某个权限时，请求必须走回浏览器端，用户在浏览器里点"允许"/"拒绝"，结果再走 WebSocket 回来：

**文件：[src/remote/RemoteSessionManager.ts](../src/remote/RemoteSessionManager.ts#L1)**

```typescript
type RemotePermissionResponse =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message: string }
```

`updatedInput` 允许用户在确认时修改工具的输入参数——比如 Claude 想执行 `rm -rf /tmp/old-dir`，用户可以修改为 `rm -rf /tmp/old-dir-backup` 再批准。这是权限系统的"编辑后批准"功能在远程模式下的实现。

---

## 完整的远程会话通信流

```
用户在浏览器打开 claude.ai/sessions/{sessionId}
        │
        ▼
浏览器连接到 Anthropic 服务器（该 session 的 channel）
        │
        │ 同时
        ▼
本地 Claude Code 启动，连接到：
wss://api.anthropic.com/v1/sessions/ws/{sessionId}/subscribe
        │
        ▼ 服务器把两者关联到同一个 session
        │
        │  用户在浏览器输入消息
        ▼
Anthropic 服务器 → WebSocket 推送 → 本地 Claude Code
        │
        ▼
Claude Code 处理消息，执行工具
        │ 工具执行中，遇到需要权限确认的操作
        ▼
Claude Code → HTTP POST sendEventToRemoteSession → 权限请求
        │
        ▼ Anthropic 服务器推送给浏览器
        │
        │ 用户在浏览器点击"允许"
        ▼
Anthropic 服务器 → WebSocket → 本地 Claude Code
        │ RemotePermissionResponse { behavior: 'allow' }
        ▼
Claude Code 继续执行，输出结果
        │
        ▼ → HTTP POST sendEventToRemoteSession → 浏览器显示结果
```

---

## 本章小结

远程会话通信层是 Claude Code 的"远程控制"基础设施：

1. **主动连接设计**：Claude Code 主动连接到 Anthropic 服务器，解决了本地无公网 IP 的问题
2. **双运行时支持**：Bun 用内置 WebSocket，Node.js 用 ws 包，认证通过 HTTP header
3. **差异化重连**：4003 永久停止，4001 线性退避，普通断线指数退避
4. **心跳保活**：每 30 秒 ping，防止 NAT/防火墙切断空闲连接
5. **viewerOnly 模式**：多人共享会话时，非主控用户只读

## 前后引路

- 这里看到的 RemotePermissionResponse 是权限系统在远程场景的扩展，权限系统基础在 **[11 章](./11-1-工具调用如何进入权限系统.md)**

## 下一节预告

还有另一种"远程控制"方式：通过 Telegram、飞书、Discord 这样的 IM 应用控制 Claude Code——这就是 Channel 系统。Channel 系统建立在 MCP 协议之上，但安全性和认证要求复杂得多。

➡️ [下一节：17-6 Channel 系统——通过 IM 控制 Agent](./17-6-Channel系统通过IM控制Agent.md)
