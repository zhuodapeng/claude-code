# 4-1 什么是 TUI，和 Web 界面有什么不同

> **本节目标**：理解 TUI 的本质和约束，搞清楚"在终端里渲染 UI"和"在浏览器里渲染 UI"究竟有哪些根本性的不同。这是理解为什么要用 Ink（而不是直接 `console.log`）的基础。

---

## 你可能没仔细想过的事：终端是什么？

在你开始学编程的第一天，你就在用终端（Terminal）——执行命令、看输出。但你有没有想过：终端的"显示"是怎么工作的？

终端不是浏览器，它没有 DOM，没有 CSS，没有像素级渲染。

**终端本质上是一个字符网格（Character Grid）。**

想象一张表格：

```
┌──────────────────────────────────────┐
│ 行 0 │ H e l l o ,   W o r l d      │
│ 行 1 │ >   █                        │
│ 行 2 │                              │
│ ...  │ ...                          │
└──────────────────────────────────────┘
```

每个格子放一个字符（或空格）。终端就是用字符填充这张表格来"显示"内容。

你能控制的只有：
- **每个格子放什么字符**
- **字符的颜色**（通过 ANSI 转义码）
- **字符的样式**（粗体、下划线等）
- **光标在哪里**

就这些。没有盒子模型，没有 Flexbox，没有事件冒泡。

---

## TUI 是什么

**TUI（Terminal User Interface）**，就是运行在终端里的图形界面——使用字符、颜色和布局来模拟 GUI 的效果。

你见过的 TUI：
- `vim` / `nano`：文本编辑器，有菜单栏、状态栏
- `htop`：系统监控，有进度条、颜色
- `git commit`（interactive）：交互式提交界面
- **Claude Code**：有对话框、工具执行状态、流式输出

---

## TUI vs Web UI：根本性差异

理解这些差异，才能理解 Ink 为什么这么设计。

### 差异一：渲染模型完全不同

**Web UI（DOM）**：
```
HTML 结构（树形）
    ↓
CSS 样式计算
    ↓
布局计算（盒子模型、Flexbox、Grid）
    ↓
像素级渲染（GPU 合成）
```

**TUI（终端）**：
```
字符序列
    ↓
ANSI 转义码（颜色、移动光标）
    ↓
终端仿真器解析
    ↓
字符网格更新
```

### 差异二：更新机制不同

**Web**：浏览器有高效的 DOM diff 和局部渲染——只更新变化的像素区域。

**终端**：

终端的"更新"是通过**写入 ANSI 转义码**来移动光标、清除行、重写内容：

```
ESC[1;1H    ← 移动光标到第1行第1列
ESC[2K      ← 清除当前行
Hello       ← 写入新内容
```

**如果每次更新都清空整个屏幕重绘**，会产生明显闪烁。
**如果只更新变化的行**，需要追踪"上一次渲染的内容"和"这次应该渲染的内容"的差异。

这正是 Ink 做的事情。

### 差异三：事件系统不同

**Web**：丰富的事件系统——鼠标移动、点击、键盘、滚动、resize……

**终端**：
- **键盘输入**：是的，有
- **鼠标**：有限支持，依赖终端仿真器（很多不支持）
- **窗口 resize**：通过信号通知
- **没有点击事件（通常）**：用键盘导航代替鼠标

### 差异四：尺寸是字符单位

**Web**：`px`、`em`、`%`、`vh/vw`

**终端**：`columns`（列数）、`rows`（行数）

终端的"分辨率"取决于用户的终端窗口大小，通常是 80 列 × 24 行或更大。

---

## 最朴素的 TUI：直接用 console.log

```typescript
console.log("Claude Code v1.0")
console.log("> 请输入你的问题...")
process.stdout.write("> ")  // 不换行
```

这能工作，但有严重的限制：

**问题一：只能往下滚**。`console.log` 只能追加内容，无法修改已经输出的内容。

**问题二：无法实时更新**。当 Claude 在"打字"时，每个 token 都要追加一行新输出——不是在同一行末尾追加，而是每次打印一整行。

**问题三：布局困难**。左边显示工具状态、右边显示对话？用字符串拼接不可能做到复杂布局。

---

## 用 ANSI 转义码直接控制：能用但痛苦

有人会想：直接用 ANSI 转义码不就行了？

```typescript
// 移动光标到第1行
process.stdout.write('\x1b[1;1H')
// 清除当前行
process.stdout.write('\x1b[2K')
// 绿色文字
process.stdout.write('\x1b[32m')
process.stdout.write('操作成功！')
// 重置颜色
process.stdout.write('\x1b[0m')
```

这在技术上完全可行，很多老旧工具就是这么做的。但：

- 代码充满 `\x1b[...` 这样的魔法字符串
- 没有布局系统，所有位置都要手动计算
- 复杂 UI（多组件、嵌套布局）的状态管理极其困难
- 更新时要追踪哪些行变了，手动写差异比较

**用 React + Ink，你写 React 组件，Ink 帮你处理所有 ANSI 转义码和差异更新。**

---

## Ink 解决了什么问题

Ink 的核心贡献是：

```
你写的（熟悉的 React 语法）
┌─────────────────────────────┐
│ <Box flexDirection="column"> │
│   <Text color="green">       │
│     Hello World              │
│   </Text>                    │
│   <Text>                     │
│     Count: {count}           │
│   </Text>                    │
│ </Box>                       │
└─────────────────────────────┘
            ↓  Ink 渲染
终端里显示的（正确布局，无闪烁）
┌────────────────┐
│ Hello World    │  ← 绿色
│ Count: 42      │
└────────────────┘
```

Ink 提供了：
1. **Yoga 布局引擎**：Facebook 的 Flexbox 实现，在终端里做 Flexbox 布局
2. **差异渲染**：只更新变化的行，无闪烁
3. **React 生命周期**：`useState`、`useEffect`、组件树——所有 React 特性都能用
4. **键盘事件处理**：通过 Ink 的 API 处理键盘输入

---

## 一个简单的 Ink 组件

```typescript
import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'   // Ink 的组件（不是 HTML 的 div/span）

function Counter() {
  const [count, setCount] = useState(0)
  
  useEffect(() => {
    const timer = setInterval(() => {
      setCount(c => c + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [])
  
  return (
    <Box flexDirection="column">
      <Text color="green">计数器</Text>
      <Text>当前值：<Text bold>{count}</Text></Text>
    </Box>
  )
}
```

这看起来就是普通的 React 组件，但它渲染在终端里，每秒更新一次，没有闪烁。

---

## 本节小结

- 终端是字符网格，用 ANSI 转义码控制颜色和光标位置
- TUI 和 Web UI 在渲染模型、事件系统、更新机制上有根本差异
- 直接用 `console.log` 或 ANSI 转义码做复杂 TUI 极其痛苦
- Ink 把 React 的组件模型搬到终端，提供 Flexbox 布局、差异渲染、事件处理
- 下一节会讲 Ink 具体如何把 React 组件树变成终端输出

## 前后呼应

- 本节说的"字符网格"和"ANSI 转义码"，在 **[4-2 节](./4-2-Ink用React渲染终端.md)** 会看到 Ink 如何处理它们
- 本节提到的 Flexbox 布局，在 **[12-3 节](./12-3-消息流的渲染.md)** 会看到实际的消息流 UI 实现

## 下一节预告

下一节深入讲 **Ink 的工作原理**——React 组件树是怎么变成终端字符的？React Reconciler 在这里扮演什么角色？

➡️ [下一节：4-2 Ink：React 在终端里是怎么工作的](./4-2-Ink用React渲染终端.md)
