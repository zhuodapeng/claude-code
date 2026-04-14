# 4-2 Ink：React 在终端里是怎么工作的

> **本节目标**：深入理解 Ink 的渲染原理——React 虚拟 DOM 如何变成终端字符，Yoga 布局引擎如何工作，以及差异渲染如何消除闪烁。这让你理解 Claude Code 的 TUI 为什么这么设计。

---

## React 的核心：渲染器是可替换的

你可能以为 React 和浏览器 DOM 是紧密绑定的。但其实 React 的架构是这样的：

```
┌─────────────────────────────────────────────────────────┐
│                   React 核心（react 包）                  │
│  - 组件系统（函数组件、类组件、Hooks）                      │
│  - 虚拟 DOM（VDOM）                                        │
│  - Reconciler（差异计算）                                  │
│                                                          │
│  ↕ 渲染器接口（react-reconciler）                          │
└─────────────────────────────────────────────────────────┘
         │                      │
         ▼                      ▼
┌──────────────────┐   ┌──────────────────────┐
│   React DOM      │   │     Ink 渲染器         │
│ （react-dom 包） │   │  （ink 包）            │
│ 操作浏览器 DOM   │   │  操作终端字符           │
└──────────────────┘   └──────────────────────┘
```

**React 核心不关心"渲染到哪里"。** 渲染器是一个插件，可以换。React Native 有自己的渲染器（操作原生 UI），Ink 有自己的渲染器（操作终端）。

这就是为什么 Ink 里你能用所有 React 特性（Hooks、Context、组件组合……），因为 React 核心没变，只换了渲染目标。

---

## 整体流程：从 JSX 到终端字符

```
你写的 JSX
┌──────────────────────────────────┐
│ <Box flexDirection="column">      │
│   <Text color="green">OK</Text>   │
│   <Text>Count: {count}</Text>     │
│ </Box>                            │
└──────────────────────────────────┘
          │
          ▼ React 编译（Babel/TSC）
React.createElement() 调用树
          │
          ▼ React Reconciler
虚拟 DOM（内存中的树形结构）
          │
          ▼ Ink 渲染器
Yoga 节点树（布局计算）
          │
          ▼ Yoga 计算布局
每个节点的 x, y, width, height
          │
          ▼ Ink 字符串化
每行的字符内容（带 ANSI 颜色码）
          │
          ▼ 差异比较（和上一帧对比）
只有变化的行的 ANSI 更新命令
          │
          ▼ 写入 process.stdout
终端显示
```

每一步都有其必要性，我们逐步拆解。

---

## 步骤一：React Reconciler（差异计算）

React 核心做的事情是**计算前后两个虚拟 DOM 树的差异**，然后通知渲染器"哪里变了，需要更新"。

这个过程叫 **Reconciliation（协调）**。

对 React DOM，"更新"就是操作浏览器 DOM（`element.textContent = 'new text'`）。

对 Ink，"更新"就是更新内存中的布局节点，然后重新计算终端输出。

**Ink 的渲染器**通过 `react-reconciler` 包实现了一套"宿主环境适配"：

```typescript
// package.json 里的关键依赖
"react-reconciler": "^0.33.0",
```

Ink 实现了 React Reconciler 要求的接口：
- `createInstance`：创建一个 Ink 节点（对应浏览器的 `createElement`）
- `appendChildToContainer`：把子节点加入容器
- `commitTextUpdate`：更新文本内容
- 等等...

这些接口告诉 React："当虚拟 DOM 有变化时，这样操作实际节点。"

---

## 步骤二：Yoga 布局引擎

**Yoga** 是 Facebook 开源的跨平台 Flexbox 布局引擎，用 C++ 写成，React Native 和 Ink 都在用它。

```typescript
// Ink 里 Box 组件的属性（完整的 Flexbox）
<Box
  flexDirection="row"         // 水平排列
  justifyContent="space-between"
  alignItems="center"
  padding={1}                 // 内边距（字符单位）
  width={40}                  // 宽度（字符数）
>
  <Text>左边</Text>
  <Text>右边</Text>
</Box>
```

Yoga 接收这些属性，计算每个节点的位置和大小：

```
输入：
- 父节点：width=80（终端宽度），flexDirection=row
- 子节点1：Text("左边")
- 子节点2：Text("右边")，justifyContent=space-between

输出：
- 子节点1：x=0, y=0, width=4, height=1
- 子节点2：x=76, y=0, width=4, height=1（靠右对齐）
```

有了每个节点的位置，Ink 就能确定在终端的哪个坐标写什么字符。

---

## 步骤三：字符串化和差异更新

Ink 维护了一个"输出缓冲区"——当前帧所有行的内容。每次 React 状态更新触发重新渲染时，Ink 计算新的输出，然后和上一帧对比：

```
上一帧输出：
行0：Claude 正在思考...
行1：> 请输入...

这一帧输出（新的 token 到来了）：
行0：Claude 正在思考...Hello
行1：> 请输入...
```

只有行 0 变了，所以只重写行 0：

```
ANSI 命令序列：
ESC[1;1H        ← 移动光标到第1行第1列
ESC[2K          ← 清除整行
Claude 正在思考...Hello  ← 写入新内容
```

**这就是为什么 Claude Code 的输出没有闪烁**——每次刷新只更新变化的行，不是清屏重绘。

---

## Ink 组件和 Web HTML 的对应关系

| Web HTML / CSS | Ink 组件 | 说明 |
|---------------|---------|------|
| `<div>` | `<Box>` | 容器元素，支持 Flexbox |
| `<span>` | `<Text>` | 文本元素，支持颜色/粗体 |
| `style={{ color: 'green' }}` | `<Text color="green">` | 颜色 |
| `style={{ fontWeight: 'bold' }}` | `<Text bold>` | 粗体 |
| `style={{ flexDirection: 'column' }}` | `<Box flexDirection="column">` | 布局方向 |
| `\n` 换行 | `<Newline />` | 空行 |

注意：Ink 里**没有 `<img>`、`<input>`、`<button>` 等元素**——终端不支持这些概念。键盘输入通过 Ink 的 `useInput` Hook 处理。

---

## Claude Code 的渲染入口

**文件：[src/ink.ts](../src/ink.ts#L18-L23)**

```typescript
export async function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> {
  // 所有渲染都包裹在 ThemeProvider 里
  return inkRender(withTheme(node), options)
}
```

Claude Code 对 Ink 的 `render` 函数做了一层封装：自动加上 `ThemeProvider`（主题支持），所以每个组件都能读取当前主题颜色。

在 `src/main.tsx` 里，应用启动时会调用这个 `render`，把整个 React 组件树挂载到终端。

---

## 一个实际的组件示例

来看 Claude Code 里的一个真实组件片段风格：

```typescript
// 典型的 Claude Code 组件结构
import * as React from 'react'
import { Box, Text } from '../../ink.js'   // 从 ink 模块导入

type Props = {
  toolName: string
  status: 'running' | 'done' | 'error'
  output?: string
}

export function ToolStatus({ toolName, status, output }: Props) {
  const statusColor = {
    running: 'yellow',
    done: 'green',
    error: 'red',
  }[status]
  
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={statusColor}>●</Text>
        <Text> {toolName}</Text>
        {status === 'running' && <Text dimColor> running...</Text>}
      </Box>
      {output && (
        <Box marginLeft={2}>
          <Text dimColor>{output}</Text>
        </Box>
      )}
    </Box>
  )
}
```

`●` 是 Claude Code 里工具调用的标记（你在 1-2 节的"观察 1"里见过）。

---

## 本节小结

- React 的渲染器是可插拔的——Ink 实现了一个操作终端的 React 渲染器
- 完整流程：JSX → 虚拟 DOM → Yoga 布局计算 → 字符串化 → 差异更新 → 写入 stdout
- Yoga 提供 Flexbox 布局支持，单位是字符数
- 差异更新（只更新变化的行）消除了闪烁
- Ink 的 `Box` 对应 `div`，`Text` 对应 `span`，没有 input/button 等概念

## 前后呼应

- 本节的整体渲染流程，在 **[12-3 节](./12-3-消息流的渲染.md)** 会看到消息列表的实际渲染实现
- 本节提到的 ThemeProvider，在 **[12-1 节](./12-1-AppState整个TUI的单一数据源.md)** 讲 AppState 时会看到它在整个组件树中的位置

## 下一节预告

下一节讲**终端渲染的限制**——Ink 很强大，但终端环境有一些根本的限制，这些限制决定了 Claude Code UI 的很多设计决策。

➡️ [下一节：4-3 终端渲染的限制与取舍](./4-3-终端渲染的限制与取舍.md)
