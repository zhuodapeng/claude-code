# 6-3 Commander：CLI 参数解析器

> **本节目标**：CLI 工具最先做的事之一是解析用户传入的参数。Claude Code 是怎么做的？为什么用 Commander.js？它的工作原理是什么？更重要的是，`main.tsx` 里那个令人眼花缭乱的 `.option(...).option(...).option(...)` 链条背后藏着什么工程决策？

---

## 从一个实际问题开始

你已经知道：`cli.tsx` 处理"快速路径"之后，最终会加载 `main.tsx`，调用 `cliMain()`。

`main.tsx` 第一件事：**解析命令行参数**。

用户可能传入这些参数：

```bash
claude-haha --model claude-sonnet-4-6 --print "帮我写个排序算法"
claude-haha --debug --verbose -p "分析这个项目" 
claude-haha --dangerously-skip-permissions
claude-haha --continue --model opus
```

你需要从 `process.argv` 里把这些参数提取出来。

`process.argv` 长什么样？

```
process.argv = [
  '/path/to/bun',           // argv[0]: 可执行文件
  '/path/to/cli.tsx',       // argv[1]: 脚本路径
  '--model',                // argv[2]: 第一个参数
  'claude-sonnet-4-6',      // argv[3]: 参数值
  '--print',                // argv[4]
  '帮我写个排序算法',          // argv[5]: prompt
]
```

---

## 朴素方案：手动解析 argv

如果自己写，最直觉的做法是字符串匹配：

```typescript
// ❌ 朴素方案：手动解析
const args = process.argv.slice(2)
const modelIdx = args.indexOf('--model')
const model = modelIdx !== -1 ? args[modelIdx + 1] : 'claude-sonnet-4-6'
const isPrint = args.includes('--print') || args.includes('-p')
const prompt = args.find(a => !a.startsWith('-'))
```

这对 3 个参数够用。但 Claude Code 有 **40+ 个 CLI 参数**。

手动解析的问题一个接一个涌现：

**问题 1：参数验证**
```bash
claude-haha --output-format invalid_value  # 应该报错，但怎么报？
```

**问题 2：参数类型转换**
```bash
claude-haha --max-turns 10   # "10" 是字符串，需要转成 number
claude-haha --max-turns abc  # 应该报错
```

**问题 3：短参数别名**
```bash
claude-haha -p "hello"   # -p 等同于 --print
claude-haha -d           # -d 等同于 --debug
```

**问题 4：子命令**
```bash
claude-haha mcp add server    # mcp 是子命令，add 是子命令的子命令
claude-haha auth login        # auth 也是子命令
```

**问题 5：生成帮助文档**
```bash
claude-haha --help  # 谁来生成这个格式化的帮助？
```

一旦你开始手工处理这些，你的参数解析代码会膨胀到几百行，充满边界情况。

**这就是为什么每个严肃的 CLI 工具都用参数解析库。**

---

## Commander.js：声明式参数解析

Commander.js 的核心思想是：**你声明参数的形状，它负责解析**。

```typescript
// 声明式：告诉 Commander "有什么参数、类型是什么、描述是什么"
program
  .option('-p, --print', 'Print response and exit')
  .option('--model <model>', 'Model to use')
  .option('--max-turns <turns>', 'Max turns', parseInt)

// 解析 process.argv
program.parse(process.argv)

// 直接拿到有类型的结果
const { print, model, maxTurns } = program.opts()
// print: boolean
// model: string | undefined
// maxTurns: number | undefined
```

Commander 帮你做完了：类型转换、验证、别名处理、帮助生成。

---

## Claude Code 里的 Commander

**文件：[src/main.tsx](../src/main.tsx#L902)**

```typescript
// 创建 Commander 实例，配置帮助显示和参数排序
const program = new CommanderCommand()
  .configureHelp(createSortedHelpConfig())  // 帮助里的选项按字母排序
  .enablePositionalOptions()               // 支持子命令有自己的 -p 等选项
```

`enablePositionalOptions()` 是一个关键配置——没有它，`claude-haha mcp add -p server` 里的 `-p` 会被解析成顶层的 `--print`，而不是 `mcp add` 子命令的参数。

然后是那条令人瞠目的链式调用——我截取有代表性的几个参数来看它的结构：

**文件：[src/main.tsx](../src/main.tsx#L968-L1006)**

```typescript
program
  .name('claude')
  .description('Claude Code - starts an interactive session by default...')
  .argument('[prompt]', 'Your prompt', String)  // 位置参数（可选）

  // 普通 boolean 参数
  .option('-p, --print', 'Print response and exit...', () => true)
  //       ↑短名  ↑长名   ↑描述                        ↑解析函数：出现即为 true
  
  // 带值的参数，有类型验证
  .addOption(
    new Option('--output-format <format>', 'Output format...')
      .choices(['text', 'json', 'stream-json'])  // 只允许这三个值
  )
  
  // 带值的参数，自定义解析（字符串 → 数字 + 验证）
  .addOption(
    new Option('--max-turns <turns>', 'Maximum number of agentic turns...')
      .argParser(Number)  // 自动把 "10" 转成 10，非数字会报错
  )
  
  // 带默认值的隐藏参数（不在 --help 里显示）
  .addOption(
    new Option('--thinking <mode>', 'Thinking mode...')
      .choices(['enabled', 'adaptive', 'disabled'])
      .hideHelp()  // 从帮助文档里隐藏
  )
  
  // 可重复的参数（每次 --plugin-dir 追加一个值）
  .option(
    '--plugin-dir <path>',
    'Load plugins from a directory...',
    (val: string, prev: string[]) => [...prev, val],  // 累加器
    [] as string[]  // 初始值：空数组
  )
  
  // 主命令的执行逻辑
  .action(async (prompt, options) => {
    // 所有参数都在 options 里，已经过类型转换和验证
    const { model, print, debug, dangerouslySkipPermissions } = options
    // ...
  })
```

**这里有个重要的工程细节**：`.option(...)` 和 `.addOption(new Option(...))` 是两种写法，功能等价，但 `addOption` 能设置 `.hideHelp()`、`.choices()`、`.argParser()` 等高级属性。

---

## preAction hook：在命令执行前做初始化

Commander 有个钩子机制——`program.hook('preAction', handler)`：在命令执行前调用 handler。

**文件：[src/main.tsx](../src/main.tsx#L905-L967)**

```typescript
program.hook('preAction', async thisCommand => {
  // 1. 等待并行预取完成（MDM 企业策略、keychain）
  await Promise.all([
    ensureMdmSettingsLoaded(),       // 企业 MDM 托管策略
    ensureKeychainPrefetchCompleted() // keychain 凭证
  ])
  
  // 2. 核心初始化
  await init()
  
  // 3. 挂载日志 sinks
  initSinks()
  
  // 4. 处理 --plugin-dir 参数（子命令共享顶层参数）
  const pluginDir = thisCommand.getOptionValue('pluginDir')
  if (Array.isArray(pluginDir) && pluginDir.length > 0) {
    setInlinePlugins(pluginDir)
  }
  
  // 5. 运行数据迁移
  runMigrations()
  
  // 6. 非阻塞地加载远端设置
  void loadRemoteManagedSettings()
  void loadPolicyLimits()
})
```

**为什么用 preAction 而不是直接在文件顶部执行？**

注意注释：`Use preAction hook to run initialization only when executing a command, not when displaying help.`

当用户运行 `claude-haha --help` 时，Commander 解析参数、生成帮助文本，**然后退出**——从不触发 `preAction`，也不触发 `.action()`。

如果初始化代码在文件顶部，即使用户只是看帮助，也要跑完全部初始化（加载配置、连网、初始化遥测……）。这完全没必要。

`preAction` 让 `--help`/`--version` 这类"不实际执行的命令"保持零初始化开销。

---

## `init()` 函数：启动的核心初始化

`preAction` 里调用的 `init()`，来自 `src/entrypoints/init.ts`。

**文件：[src/entrypoints/init.ts](../src/entrypoints/init.ts#L57-L60)**

```typescript
export const init = memoize(async (): Promise<void> => {
  // memoize：只执行一次，后续调用直接返回缓存结果
  profileCheckpoint('init_function_start')
  
  // ...
})
```

`memoize` 是 lodash 的工具——**把函数的返回值缓存起来，相同参数的调用直接返回缓存**。

这里 `init()` 无参数，所以效果是：**整个进程生命周期内只执行一次**。

为什么需要 memoize？因为 `init()` 可能从多个地方被调用（不同的子命令、恢复会话逻辑等），但初始化只应该跑一次。

`init()` 具体做什么？

```typescript
export const init = memoize(async () => {
  // 1. 开启配置系统（读取 .claude/settings.json）
  enableConfigs()
  
  // 2. 应用"安全"环境变量（信任对话框出现前）
  applySafeConfigEnvironmentVariables()
  
  // 3. 从 settings.json 注入额外 CA 证书到 TLS
  applyExtraCACertsFromConfig()
  
  // 4. 设置进程退出时的清理钩子
  setupGracefulShutdown()
  
  // 5. 非阻塞：初始化 1P 事件日志（Analytics）
  void Promise.all([
    import('../services/analytics/firstPartyEventLogger.js'),
    import('../services/analytics/growthbook.js'),
  ]).then(([fp, gb]) => {
    fp.initialize1PEventLogging()
    gb.onGrowthBookRefresh(...)
  })
  
  // 6. 非阻塞：填充 OAuth 账户信息缓存
  void populateOAuthAccountInfoIfNeeded()
  
  // 7. 非阻塞：检测 JetBrains IDE 连接
  void initJetBrainsDetection()
  
  // 8. 非阻塞：检测 Git 仓库（用于 PR 功能）
  void detectCurrentRepository()
  
  // 9. 配置代理、mTLS（企业网络）
  configureGlobalAgents()
  configureGlobalMTLS()
  
  // 10. 设置 Windows 的 shell 路径
  setShellIfWindows()
  
  // 11. 非阻塞：预连接 Anthropic API（提前建立 TCP 连接）
  void preconnectAnthropicApi()
})
```

注意大量的 `void xxx()` ——这些是**故意不等待的异步操作**。

这里的工程思维是：**能并行的全部并行**。

- 检测 JetBrains IDE 和预连接 API 可以并行跑
- 这些任务只要在用户真正开始对话之前完成就行
- 用 `void` 把它们"扔出去"，不阻塞当前初始化流程

等到用户在 TUI 里输入第一条消息、真正触发 API 请求时，这些任务早就完成了。

---

## 参数最终怎么流到代码里

Commander 解析完参数后，所有值都在 `.action()` 的 `options` 对象里：

**文件：[src/main.tsx](../src/main.tsx#L1090-L1107)**

```typescript
.action(async (prompt, options) => {
  // 解构出所有需要的参数
  const {
    debug = false,
    dangerouslySkipPermissions,
    tools: baseTools = [],
    allowedTools = [],
    disallowedTools = [],
    mcpConfig = [],
    permissionMode: permissionModeCli,
    addDir = [],
    model,
    print,
    outputFormat,
    // ... 还有很多
  } = options
  
  // 这些值在后续的 setup() 和渲染 TUI 时会用到
})
```

这些 `options` 值会一路传下去，最终影响：
- 用哪个模型（`model`）
- 是否显示 TUI（`print` 决定是否走无 UI 的 pipe 模式）
- 工具权限（`allowedTools`、`dangerouslySkipPermissions`）
- 会话恢复（`continue`、`resume`）

---

## 一个值得注意的细节：TypeScript 类型推断

Commander 有个叫 **extra-typings** 的特性，能自动从 `.option()` 调用推断出 `options` 的 TypeScript 类型。

**文件：[src/main.tsx](../src/main.tsx#L907)**

注释里有一句：`thisCommand.opts() is typed {} here because this hook is attached before .option('--plugin-dir', ...) in the chain — extra-typings builds the type as options are added.`

这说明类型是**动态构建的**——Commander 在 `.option()` 链条构建时同步推断类型。在 `preAction` 里拿 `opts()` 时，类型还不完整（因为链条还没完全建好），所以需要手动 cast。

这是一个工程上的小妥协：`preAction` 拿不到完整的类型，但逻辑上在执行命令前一定是完整的，所以问题不大。

---

## 本节小结

- Commander.js 是声明式的参数解析：你描述参数的形状，它负责解析、验证、生成帮助
- `enablePositionalOptions()` 让子命令能有自己的参数，不和顶层参数冲突
- `preAction` hook 只在真正执行命令时触发，`--help` 不触发，节省了不必要的初始化
- `init()` 用 `memoize` 保证全局只运行一次，里面大量使用 `void xxx()` 并行执行非关键初始化
- `options` 对象从 Commander 解析后一路往下传，贯穿整个启动流程

## 前后呼应

- 本节的 `init()` 里的 `preconnectAnthropicApi()`，就是为 **[5-3 节](./5-3-流式响应SSE协议.md)** 讲的 SSE 连接提前预热
- 本节的 `allowedTools`、`dangerouslySkipPermissions` 参数，在 **[11-1 节](./11-1-权限系统的设计动机.md)** 会看到它们如何影响工具权限决策

## 下一节预告

参数解析完毕，`preAction` 也跑完了。接下来 `.action()` 里发生了什么？Claude Code 怎么一步步从"刚拿到 options 对象"走到"TUI 出现在屏幕上"？

➡️ [下一节：6-4 初始化序列：20 步启动编排](./6-4-初始化序列20步启动编排.md)
