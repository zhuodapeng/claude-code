# 6-6 React 树的渲染：从 render() 开始

> **本节目标**：`renderAndRun(root, <REPL .../>)` 被调用——然后 TUI 出现了。这一行代码背后发生了什么？React 是怎么在终端里渲染的？`<REPL>` 这个 5000 行组件的 JSX 结构长什么样？状态从哪里来？

---

## 一切从这一行开始

**文件：[src/interactiveHelpers.tsx](../src/interactiveHelpers.tsx#L98-L103)**

```typescript
export async function renderAndRun(root: Root, element: React.ReactNode): Promise<void> {
  root.render(element)       // 把组件树挂上去
  startDeferredPrefetches()  // 启动"第二波"后台预取
  await root.waitUntilExit() // 阻塞，直到用户退出
  await gracefulShutdown(0)  // 清理退出
}
```

`root.render(element)` 这一行触发了整个 React 渲染机制。

但 `root` 是什么？它不是浏览器的 `ReactDOM.createRoot()`——它是 Ink 实现的 `Root`。

---

## Ink 的 Root：React 渲染器的"画布"

**文件：[src/ink.ts](../src/ink.ts#L25-L30)**

```typescript
export async function createRoot(options?: RenderOptions): Promise<Root> {
  const root = await inkCreateRoot(options)
  return {
    ...root,
    // 包装 render，自动注入全局主题
    render: node => root.render(withTheme(node)),
  }
}
```

`inkCreateRoot` 来自 Claude Code 自己维护的 Ink fork。

**文件：[src/ink/root.ts](../src/ink/root.ts#L67-L71)**

```typescript
export type Root = {
  render: (node: ReactNode) => void   // 挂载/更新组件树
  unmount: () => void                  // 卸载
  waitUntilExit: () => Promise<void>  // 等待退出
}
```

`root.render(node)` 做的事和 Web 里的 `ReactDOM.render()` 完全一样——把一个 React 组件树挂到"容器"上。

区别在于"容器"：
- Web：`<div id="root">` DOM 节点
- Ink：`stdout`（进程的标准输出流）

React 本身不关心容器是什么——它只关心组件树的状态变化。把变化"渲染"到哪里，是渲染器（Renderer）的工作。Ink 就是一个自定义的 React 渲染器，目标是终端字符矩阵而不是 DOM。

---

## withTheme：主题注入

注意 `render: node => root.render(withTheme(node))`——每次渲染都自动包一层 `withTheme`。

这确保了 Claude Code 里所有组件都能访问到统一的颜色主题，不需要每个组件自己 import 主题。

---

## REPL 组件树的结构

`root.render()` 接收的 `element` 是什么？

**文件：[src/main.tsx](../src/main.tsx#L3190-L3197)**

```typescript
// 这是最常见的启动路径（无 --resume，无特殊模式）
await renderAndRun(root, 
  <AppStateProvider
    initialState={initialState}
    onChangeAppState={onChangeAppState}
  >
    <REPL
      commands={commands}
      initialTools={tools}
      initialMessages={initialMessages}
      mcpClients={mcpClients}
      systemPrompt={customSystemPrompt}
      appendSystemPrompt={appendSystemPrompt}
      thinkingConfig={thinkingConfig}
      // ...还有很多 props
    />
  </AppStateProvider>
)
```

最外层是 `AppStateProvider`——这是第 4 章讲的外部 store 的 React 包装层。它把 `initialState` 存入 store，并通过 Context 把 `useAppState` hook 提供给整个组件树。

`REPL` 是核心组件，接收所有初始化时准备好的数据（commands、tools、messages 等）作为 props。

---

## REPL 组件内部：5000 行的"主控制器"

**文件：[src/screens/REPL.tsx](../src/screens/REPL.tsx#L573)**

`REPL` 是个巨型组件。5000 行不是因为它的设计不好，而是因为**它是整个 Claude Code 交互逻辑的中心**——就像一个复杂桌面应用的主窗口。

它的内部结构分几层：

### 1. 从 AppState 订阅需要的状态

```typescript
// REPL 里密集地从 AppState 读取各种状态
const toolPermissionContext = useAppState(s => s.toolPermissionContext)
const verbose = useAppState(s => s.verbose)
const mcp = useAppState(s => s.mcp)
const plugins = useAppState(s => s.plugins)
const initialMessage = useAppState(s => s.initialMessage)
const queuedCommands = useCommandQueue()  // 另一个外部 store
// ...还有很多
```

注意：这些 `useAppState` 调用每一个都是精确订阅——只有对应的状态片段变化时，才触发重渲染。

### 2. 本地状态（只影响 UI 的状态）

```typescript
const [screen, setScreen] = useState<Screen>('prompt')  // 'prompt' | 'transcript'
const [messages, setMessages] = useState(initialMessages)  // 对话消息列表
const [streamingToolUses, setStreamingToolUses] = useState([])  // 正在流式输出的工具调用
const [abortController, setAbortController] = useState<AbortController | null>(null)
```

这些是 React 局部状态——只存在于 REPL 组件内部，不需要全局共享。

### 3. 大量的自定义 hooks

REPL 里调用了数十个自定义 hooks，每个 hook 封装一个子功能：

```typescript
useModelMigrationNotifications()   // 模型版本迁移提醒
useIDEStatusIndicator(...)         // IDE 连接状态指示器
useMcpConnectivityStatus(...)      // MCP 服务器连接状态
useRateLimitWarningNotification()  // API 速率限制警告
useFastModeNotification()          // Fast 模式通知
useSkillsChange(...)               // skill 文件变化监听（热重载）
useManagePlugins(...)              // 插件管理
// ...还有很多
```

这种设计是 React 的经典模式：**把副作用和状态逻辑抽取到自定义 hook，保持组件本身的 JSX 干净**。

### 4. 计算派生状态

```typescript
// 合并工具列表：内置工具 + MCP 工具 + 权限过滤
const mergedTools = useMergedTools(combinedInitialTools, mcp.tools, toolPermissionContext)

// 合并命令列表：本地命令 + 插件命令 + MCP 命令
const commandsWithPlugins = useMergedCommands(localCommands, plugins.commands)
const mergedCommands = useMergedCommands(commandsWithPlugins, mcp.commands)
```

### 5. 最终的 JSX 树

REPL 的 return JSX 大概长这样（极度简化）：

```tsx
return (
  <KeybindingSetup>
    {/* 键盘快捷键处理层 */}
    <GlobalKeybindingHandlers ... />
    <CommandKeybindingHandlers ... />
    <CancelRequestHandler ... />
    
    <FullscreenLayout scrollRef={scrollRef}
      scrollable={
        // 中间的可滚动消息列表
        <Messages
          messages={displayedMessages}
          tools={tools}
          // ...
        />
      }
      bottom={
        // 底部固定的输入框
        <PromptInput
          onSubmit={onSubmit}
          // ...
        />
      }
    />
    
    {/* 各种覆盖层：工具确认对话框、通知、状态栏 */}
    {toolJSX?.jsx}
    {notifications}
    <StatusBar ... />
  </KeybindingSetup>
)
```

---

## React 状态变化如何触发重渲染

整个流程是这样的：

```
Claude API 返回流式 token
        ↓
queryLoop 收到新 token
        ↓
调用 setMessages([...messages, newMessage])
        ↓
React 检测到 messages 状态变化
        ↓
REPL 重新渲染（React reconciler 运行）
        ↓
Ink 的渲染器计算差异
        ↓
Yoga 布局引擎重新计算字符坐标
        ↓
生成 ANSI 转义码序列写入 stdout
        ↓
终端屏幕更新
```

这就是为什么 Claude 的回复能"流式"显示——每个 token 到来，触发一次 React 更新，触发一次终端重绘。

---

## 为什么 REPL 不按更小的组件拆分？

5000 行的组件看起来违反了"组件要小"的原则。但有工程上的理由：

1. **大量相互依赖的状态**：`messages`、`streamingToolUses`、`abortController` 等都紧密相关，提升到父组件更自然
2. **性能控制**：整个 REPL 是一个 `memo` 边界——内部状态变化不会传播到外部
3. **hooks 的规则**：React hooks 不能在条件语句里调用，所有 hooks 必须在同一个组件顶层，这倾向于把相关逻辑集中

实际上，REPL 把可以独立的部分都拆成了子组件（`Messages`、`PromptInput`、`FullscreenLayout`）。5000 行里，大部分是 hooks 逻辑，JSX 部分相对紧凑。

---

## 本节小结

- `renderAndRun()` 调用 `root.render()`，把 React 组件树挂到 Ink 的终端"画布"上
- Ink 是一个自定义 React 渲染器，目标是终端字符矩阵，工作方式和 ReactDOM 相同
- `AppStateProvider` 包裹 `REPL`，提供全局状态访问
- `REPL` 是 5000 行的"主控制器"组件，通过 `useAppState` 订阅全局状态，通过 `useState` 管理局部 UI 状态
- 每个 API token 到来 → `setMessages()` → React 重渲染 → Ink 重绘 → 终端更新

## 前后呼应

- 本节的 `setMessages()` 触发重渲染流程，在 **[9-3 节](./9-3-流式响应解析逐事件处理.md)** 会看到 token 怎么触发这个更新
- 本节的 `AppStateProvider` 和状态管理，在 **[12-2 节](./12-2-AppState的设计.md)** 会深入拆解

## 第 6 章小结

至此，第 6 章完整地追踪了从 `claude-haha` 命令到 TUI 出现的全过程：

```
bin/claude-haha（bash 脚本）
    ↓  exec bun --env-file=.env
src/entrypoints/cli.tsx（快速路径路由）
    ↓  await import('../main.js')
src/main.tsx 的 cliMain()
    ↓  Commander 解析参数
    ↓  preAction: init()
    ↓  setup() + getCommands() [并行]
    ↓  showSetupScreens() [信任门控]
    ↓  renderAndRun()
src/screens/REPL.tsx（主界面）
    ↓  Ink 渲染到终端
TUI 出现！
```

## 下一节预告

第 7 章：Tool 系统——Claude Code 的工具是什么？怎么定义？怎么执行？权限检查在哪里？

➡️ [下一节：7-1 Tool 的本质：为什么 Claude 需要工具](./7-1-Tool的本质为什么Claude需要工具.md)
