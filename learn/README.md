# Claude Code 深度学习课程

> 从"完全不了解"到"能从零重新设计一个类似系统"的完整学习路径

本课程基于 Claude Code 本地化版本的源码，系统讲解一个**生产级 AI Agent CLI** 的设计与实现。课程不是代码注释的堆砌，而是从**设计问题**出发，带你理解每一个架构决策背后的"为什么"。

读完本课程，你应该能够：
- 完整理解 Claude Code 的整体架构与各子系统
- 解释每个关键设计决策的权衡与取舍
- 从零设计并实现一个类似的 AI Agent CLI

---

## 课程结构

### 第一部分：全景认知

| 章节 | 标题 |
|------|------|
| [1-1](./1-1-这个项目是什么为什么存在.md) | 这个项目是什么，为什么存在 |
| [1-2](./1-2-快速把项目跑起来.md) | 快速把项目跑起来 |
| [1-3](./1-3-目录结构全景扫描.md) | 目录结构全景扫描 |
| [1-4](./1-4-项目技术选型解读.md) | 项目技术选型解读：为什么这些技术 |

### 第二部分：前置知识 A — TypeScript 关键特性

| 章节 | 标题 |
|------|------|
| [2-1](./2-1-TypeScript核心语法速通.md) | TypeScript 核心语法速通（对 Java 开发者） |
| [2-2](./2-2-函数与模块系统.md) | 函数作为一等公民 + 模块系统 |
| [2-3](./2-3-Zod运行时类型校验.md) | Zod：运行时类型校验 |

### 第三部分：前置知识 B — 异步编程深入

| 章节 | 标题 |
|------|------|
| [3-1](./3-1-为什么JavaScript是单线程的.md) | 为什么 JavaScript 是单线程的 |
| [3-2](./3-2-Promise把未来的值包起来.md) | Promise：把"未来的值"包起来 |
| [3-3](./3-3-async-await让异步看起来同步.md) | async/await：让异步代码看起来同步 |
| [3-4](./3-4-Generator函数可暂停的函数.md) | Generator 函数：可暂停的函数 |
| [3-5](./3-5-AsyncGenerator流式数据的关键.md) | AsyncGenerator：流式数据的关键 |
| [3-6](./3-6-并发控制与AbortController.md) | 并发控制与 AbortController |

### 第四部分：前置知识 C — React 与 Ink TUI

| 章节 | 标题 |
|------|------|
| [4-1](./4-1-什么是TUI和Web界面有什么不同.md) | 什么是 TUI，和 Web 界面有什么不同 |
| [4-2](./4-2-Ink用React渲染终端.md) | Ink：React 在终端里是怎么工作的 |
| [4-3](./4-3-终端渲染的限制与取舍.md) | 终端渲染的限制与取舍 |
| [4-4](./4-4-外部状态存储为什么不用useState.md) | 外部状态存储：为什么 Claude Code 不用 useState |
| [4-5](./4-5-useSyncExternalStore.md) | useSyncExternalStore：React 18 的状态同步新方式 |

### 第五部分：前置知识 D — LLM API 工作原理

| 章节 | 标题 |
|------|------|
| [5-1](./5-1-Token和上下文窗口.md) | 什么是 Token？Context Window 是什么意思？ |
| [5-2](./5-2-流式响应是怎么工作的.md) | 流式响应（Streaming）是怎么工作的 |
| [5-3](./5-3-工具调用的完整协议.md) | 工具调用（Tool Use）的完整协议 |
| [5-4](./5-4-System-Prompt和消息结构.md) | System Prompt、消息结构与多轮对话 |
| [5-5](./5-5-用10行代码调用Anthropic-API.md) | 用 10 行代码调用一次 Anthropic API |
| [5-6](./5-6-模型参数与Fast模式.md) | 模型参数：temperature、max_tokens、Fast 模式 |

### 第六部分：启动链路

| 章节 | 标题 |
|------|------|
| [6-1](./6-1-入口脚本bin-claude-haha做了什么.md) | 入口脚本：bin/claude-haha 做了什么 |
| [6-2](./6-2-快速路径优化cli-tsx的设计思路.md) | 快速路径优化：cli.tsx 的设计思路 |
| [6-3](./6-3-Commander-CLI参数解析器.md) | Commander：CLI 参数解析器 |
| [6-4](./6-4-初始化序列20步启动编排.md) | 初始化序列：20 步启动编排 |
| [6-5](./6-5-启动模式分支.md) | 启动模式分支：TUI / Print / SDK 模式 |
| [6-6](./6-6-React树的渲染.md) | React 树的渲染：从 render() 开始 |

### 第七部分：Tool 系统

| 章节 | 标题 |
|------|------|
| [7-1](./7-1-什么是工具Claude为什么需要工具.md) | 什么是"工具"？Claude 为什么需要工具 |
| [7-2](./7-2-Tool接口的设计.md) | Tool 接口的设计：一个工具需要哪些要素 |
| [7-3](./7-3-buildTool工厂函数模式.md) | buildTool()：工厂函数模式 |
| [7-4](./7-4-BashTool剖析.md) | BashTool 剖析：最简单也最危险的工具 |
| [7-5](./7-5-文件操作工具族.md) | 文件操作工具族：Read/Write/Edit/Glob/Grep |
| [7-6](./7-6-工具的UI渲染.md) | 工具的 UI 渲染：执行中与执行完的显示 |
| [7-7](./7-7-工具注册表assembleToolPool.md) | 工具注册表：assembleToolPool() 的完整逻辑 |
| [7-8](./7-8-MCP工具.md) | MCP 工具：如何把外部服务变成 Claude 的工具 |

### 第八部分：主流程 A — 消息入口

| 章节 | 标题 |
|------|------|
| [8-1](./8-1-用户在终端输入时发生了什么.md) | 用户在终端输入时发生了什么 |
| [8-2](./8-2-processUserInput消息预处理.md) | processUserInput()：消息预处理 |
| [8-3](./8-3-System-Prompt的构建.md) | System Prompt 的构建：getSystemPrompt() |
| [8-4](./8-4-submitMessage的前半程.md) | QueryEngine.submitMessage() 的前半程 |

### 第九部分：主流程 B — query loop 核心循环

| 章节 | 标题 |
|------|------|
| [9-1](./9-1-queryLoop的全局结构.md) | queryLoop() 的全局结构：一个 while true 循环 |
| [9-2](./9-2-调用Anthropic-API.md) | 调用 Anthropic API：claude() 函数做了什么 |
| [9-3](./9-3-流式响应解析逐事件处理.md) | 流式响应解析：逐事件处理 |
| [9-4](./9-4-text-delta事件Claude在打字.md) | text_delta 事件：Claude 在"打字" |
| [9-5](./9-5-tool-use事件Claude要用工具了.md) | tool_use 事件：Claude 要用工具了 |
| [9-6](./9-6-runTools工具执行编排.md) | runTools()：工具执行编排 |
| [9-7](./9-7-工具结果如何喂回给Claude.md) | 工具结果如何"喂回"给 Claude |
| [9-8](./9-8-循环的终止条件.md) | 循环的终止条件 |
| [9-9](./9-9-认知反转queryLoop是状态机.md) | 认知反转：queryLoop 不是请求-响应，而是状态机 |

### 第十部分：主流程 C — QueryEngine 会话管理

| 章节 | 标题 |
|------|------|
| [10-1](./10-1-QueryEngine-vs-query两层架构.md) | QueryEngine vs query()：为什么需要两层 |
| [10-2](./10-2-消息历史的生命周期.md) | 消息历史（mutableMessages）的生命周期 |
| [10-3](./10-3-SDK模式与TUI模式的统一接口.md) | SDK 模式与 TUI 模式的统一接口 |
| [10-4](./10-4-submitMessage完整序列图.md) | submitMessage() 的完整序列图 |

### 第十一部分：权限系统

| 章节 | 标题 |
|------|------|
| [11-1](./11-1-工具调用如何进入权限系统.md) | 工具调用如何进入权限系统：三层调用链全景 |
| [11-2](./11-2-权限规则的数据结构.md) | 权限规则的数据结构：PermissionRule 与 ToolPermissionContext |
| [11-3](./11-3-七步流水线逐行追踪.md) | 七步流水线逐行追踪：hasPermissionsToUseToolInner |
| [11-4](./11-4-checkPermissions与passthrough语义.md) | checkPermissions 与 passthrough 语义 |
| [11-5](./11-5-用户响应与Race竞争机制.md) | 用户响应与 Race 竞争机制：createResolveOnce |
| [11-6](./11-6-bypassPermissions与安全底线.md) | bypassPermissions 与安全底线：两层 killswitch |
| [11-6](./11-6-AI分类器辅助危险命令识别.md) | AI 分类器辅助：危险命令如何被识别 |

### 第十二部分：状态管理与 TUI 渲染

| 章节 | 标题 |
|------|------|
| [12-1](./12-1-AppState整个TUI的单一数据源.md) | AppState：整个 TUI 的单一数据源 |
| [12-2](./12-2-订阅发布模式createStore.md) | 订阅-发布模式：createStore() 是怎么工作的 |
| [12-3](./12-3-消息流的渲染.md) | 消息流的渲染：从 SDKMessage 到终端显示 |
| [12-4](./12-4-实时更新流式token如何驱动TUI刷新.md) | 实时更新：流式 token 如何驱动 TUI 刷新 |

### 第十三部分：上下文压缩

| 章节 | 标题 |
|------|------|
| [13-1](./13-1-Token窗口的上限与长会话问题.md) | Token 窗口的上限与长会话问题 |
| [13-2](./13-2-AutoCompact触发时机.md) | Auto Compact 的触发时机 |
| [13-3](./13-3-压缩的实现让Claude总结自己.md) | 压缩的实现：让 Claude 总结自己 |
| [13-4](./13-4-压缩后的消息结构.md) | 压缩后的消息结构：CompactBoundary |

### 第十四部分：多 Agent 系统

| 章节 | 标题 |
|------|------|
| [14-1](./14-1-什么是多Agent.md) | 什么是多 Agent？为什么单 Agent 不够？ |
| [14-2](./14-2-AgentTool派发子Agent的工具.md) | AgentTool：派发子 Agent 的工具 |
| [14-3](./14-3-子Agent的隔离独立Context窗口.md) | 子 Agent 的隔离：独立 Context 窗口 |
| [14-4](./14-4-三种执行模式.md) | 三种执行模式：本地/远程/Worktree |
| [14-5](./14-5-异步后台Agent任务生命周期管理.md) | 异步后台 Agent：任务的生命周期管理 |
| [14-6](./14-6-Coordinator模式多Agent的指挥官.md) | Coordinator 模式：多 Agent 的指挥官 |
| [14-7](./14-7-Swarm模式与Teammate模式.md) | Swarm 模式与 Teammate 模式 |

### 第十五部分：记忆系统

| 章节 | 标题 |
|------|------|
| [15-1](./15-1-为什么需要记忆系统.md) | 为什么需要记忆系统？ |
| [15-2](./15-2-MEMORY-md存储格式设计.md) | MEMORY.md：记忆的存储格式设计 |
| [15-3](./15-3-记忆注入System-Prompt.md) | 记忆注入：如何把记忆加进 System Prompt |
| [15-4](./15-4-记忆的上限与截断策略.md) | 记忆的上限：截断策略的设计取舍 |
| [15-5](./15-5-自动记忆提取.md) | 自动记忆提取：Claude 如何主动写记忆 |

### 第十六部分：Skills 系统

| 章节 | 标题 |
|------|------|
| [16-1](./16-1-Skills是什么和工具的区别.md) | Skills 是什么？和"工具"有什么本质区别 |
| [16-2](./16-2-磁盘Skills与BundledSkills.md) | 磁盘 Skills 与 Bundled Skills |
| [16-3](./16-3-SkillTool执行流程.md) | SkillTool：Skills 如何被 Claude 调用 |
| [16-4](./16-4-Skills和SystemPrompt的关系.md) | Skills 和 System Prompt 的关系 |
| [16-5](./16-5-实现一个自定义Skill.md) | 实现一个自定义 Skill |

### 第十七部分：MCP、插件与远程系统

| 章节 | 标题 |
|------|------|
| [17-1](./17-1-MCP协议是什么.md) | MCP 协议是什么：AI 工具的标准化接口 |
| [17-2](./17-2-MCP客户端实现.md) | MCP 客户端实现：如何连接外部 MCP 服务器 |
| [17-3](./17-3-MCP工具转换.md) | MCP 工具转换：外部工具如何变成内置工具 |
| [17-4](./17-4-插件系统.md) | 插件系统：扩展 Claude Code 的能力 |
| [17-5](./17-5-远程会话WebSocket通信层.md) | 远程会话：WebSocket 通信层 |
| [17-6](./17-6-Channel系统通过IM控制Agent.md) | Channel 系统：通过 IM 控制 Agent |

### 第十八部分：从零复现

| 章节 | 标题 |
|------|------|
| [18-1](./18-1-先设计再实现画出系统草图.md) | 先设计，再实现：画出你的系统草图 |
| [18-2](./18-2-第一步50行实现最简LLM-CLI.md) | 第一步：50 行实现最简 LLM CLI |
| [18-3](./18-3-第二步加入工具调用.md) | 第二步：加入工具调用 |
| [18-4](./18-4-第三步加入流式输出.md) | 第三步：加入流式输出 |
| [18-5](./18-5-第四步加入Ink-TUI.md) | 第四步：加入 Ink TUI |
| [18-6](./18-6-第五步加入权限系统.md) | 第五步：加入权限系统 |
| [18-7](./18-7-第六步加入记忆系统.md) | 第六步：加入记忆系统 |
| [18-8](./18-8-第七步加入子Agent.md) | 第七步：加入子 Agent |
| [18-9](./18-9-如果让我重新设计.md) | 如果让我重新设计：10 个不同的决策 |

---

## 如何阅读本课程

1. **按顺序阅读**：每一节都建立在前面所有内容之上，不建议跳读
2. **在 VS Code 中阅读**：所有代码引用都支持 Ctrl+Click 跳转到源码
3. **遇到不懂先往后读**：有些概念需要后面的内容才能完全理解，先有印象，回头再补
4. **动手做第 18 章**：最后一章不是用来读的，是用来做的

---

*课程语言：中文 | 目标读者：有前端基础的大学生 | 预期学习时长：40-60 小时*
