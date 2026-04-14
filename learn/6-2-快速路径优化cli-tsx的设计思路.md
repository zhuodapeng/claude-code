# 6-2 快速路径优化：cli.tsx 的设计思路

> **本节目标**：理解 `src/entrypoints/cli.tsx` 的核心设计——动态导入（dynamic import）如何实现快速路径优化，以及为什么这对 CLI 工具的启动速度至关重要。

---

## 启动速度的重要性

CLI 工具的启动速度比 Web 应用重要得多。

Web 应用：用户理解"加载中"，等待 2-3 秒是可接受的。

CLI 工具：用户期望**立即响应**。如果 `claude-haha --version` 需要 2 秒才返回，用户会以为命令没成功或者环境有问题。

Claude Code 是一个有数百个模块、几百 KB TypeScript 代码的大型项目。如果每次启动都要加载所有模块，启动时间会相当长。

**`cli.tsx` 的核心设计就是解决这个问题。**

---

## 朴素方案：顶层 import

最简单的写法是在文件顶部导入所有模块：

```typescript
// ❌ 朴素方案：一次性加载所有模块
import { startMainUI } from './main.js'
import { enableConfigs } from '../utils/config.js'
import { bridgeMain } from '../bridge/bridgeMain.js'
import { daemonMain } from '../daemon/main.js'
// ... 50+ 个 import

async function main() {
  const args = process.argv.slice(2)
  
  if (args[0] === '--version') {
    console.log(version)
    return
  }
  
  // 启动完整 UI...
}
```

**问题**：即使用户只是想看版本号（`--version`），也要先加载所有模块，包括那些复杂的业务逻辑模块。这些模块的加载（解析、执行模块顶层代码）需要时间。

---

## 真实方案：动态导入 + 快速路径

**文件：[src/entrypoints/cli.tsx](../src/entrypoints/cli.tsx#L28-L48)**

```typescript
/**
 * Bootstrap entrypoint - checks for special flags before loading the full CLI.
 * All imports are dynamic to minimize module evaluation for fast paths.
 * Fast-path for --version has zero imports beyond this file.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ████ 快速路径：--version 完全不加载任何模块 ████
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // MACRO.VERSION 在构建时被内联为字符串常量，不需要任何 import
    console.log(`${MACRO.VERSION} (Claude Code)`);
    return;
  }

  // 非 --version 路径才开始加载模块（动态 import）
  const { profileCheckpoint } = await import('../utils/startupProfiler.js');
  profileCheckpoint('cli_entry');

  // 后续根据 args[0] 判断走哪条路径，各路径按需加载自己的模块
  if (args[0] === '--dump-system-prompt') {
    const { enableConfigs } = await import('../utils/config.js');
    // ... 只加载这条路径需要的模块
    return;
  }
  
  // 远程控制路径
  if (feature('BRIDGE_MODE') && args[0] === 'remote-control') {
    const { bridgeMain } = await import('../bridge/bridgeMain.js');
    await bridgeMain(args.slice(1));
    return;
  }
  
  // 默认路径：完整 UI（最后才加载，代价最大）
  const { default: mainModule } = await import('../main.js');
  await mainModule(args);
}

main();
```

**关键设计**：所有 `import` 都是**动态 import**（`await import(...)`），而不是顶层静态 import。

---

## 动态 import vs 静态 import

**静态 import（顶层）**：

```typescript
import { something } from './module.js'  // 文件加载时立即执行
```

模块在文件被解析时就立即加载，无论后面是否用到。

**动态 import（按需）**：

```typescript
const { something } = await import('./module.js')  // 代码执行到这里才加载
```

模块只在代码执行到这一行时才加载。在此之前，这个模块根本不存在于内存中。

---

## 快速路径的效果

```
用户输入：claude-haha --version

执行流程：
1. Bun 加载 cli.tsx（很小的文件）
2. 执行到 if (args[0] === '--version') 分支
3. 直接打印版本号
4. 退出

加载的模块：只有 cli.tsx 本身
时间：< 50ms
```

```
用户输入：claude-haha（启动完整 TUI）

执行流程：
1. Bun 加载 cli.tsx
2. 没有特殊参数，执行到最后的 import('../main.js')
3. 开始加载 main.tsx（4690 行的怪兽）
4. main.tsx 加载触发更多模块加载...
5. 所有初始化完成，TUI 出现

加载的模块：几十个核心模块
时间：~500-800ms（已经很快了，正常 Node.js 会更慢）
```

---

## 各路径的加载模式

`cli.tsx` 里有大约 10 个不同的快速路径：

```
args[0] === '--version'
    → 零模块加载，立即退出

args[0] === '--dump-system-prompt'
    → 加载 config.js + prompts.js（开发/调试用）

args[0] === '--daemon-worker'
    → 加载 daemon/workerRegistry.js（内部 daemon 工作进程）

args[0] === 'remote-control'
    → 加载 bridge/bridgeMain.js（远程控制服务）

args[0] === '--computer-use-mcp'
    → 加载 computerUse/mcpServer.js（Computer Use 功能）

（无特殊参数）
    → 加载 main.js（完整初始化，最重的路径）
```

每条路径**按需加载各自需要的模块**，不加载其他路径的代码。

---

## `feature()` 特性开关

你会注意到代码里有大量的 `feature('BRIDGE_MODE')` 这样的判断：

```typescript
if (feature('BRIDGE_MODE') && args[0] === 'remote-control') {
  const { bridgeMain } = await import('../bridge/bridgeMain.js');
  ...
}
```

**文件：[src/entrypoints/cli.tsx](../src/entrypoints/cli.tsx#L1)**

```typescript
import { feature } from 'bun:bundle';
```

`feature()` 是 Bun 的构建时特性开关。在打包（`bun build`）时：
- 如果某个 feature 被禁用，整个 `if (feature('...')) { ... }` 块会被**彻底删除**（Dead Code Elimination）
- 这意味着内部功能不会出现在对外发布的版本里

对于本地运行版本（不打包），`feature()` 总是返回 `true`，所有功能都可用。

---

## `profileCheckpoint`：启动性能追踪

```typescript
const { profileCheckpoint } = await import('../utils/startupProfiler.js');
profileCheckpoint('cli_entry');
```

这是内部性能追踪机制——记录启动过程中各个关键节点的时间戳。

在 `main.tsx` 里也有：

```typescript
import { profileCheckpoint } from './utils/startupProfiler.js';
profileCheckpoint('main_tsx_entry');  // 第一行就是计时
```

通过分析这些时间戳，开发团队能准确知道启动的哪个阶段最慢，针对性优化。

---

## 本节小结

- `cli.tsx` 是 Bun 执行的第一个 TypeScript 文件，职责是路由到正确的执行路径
- **动态 import** 实现"按需加载"——只有代码执行到那一行才加载模块
- `--version` 是"零模块"快速路径，延迟极低
- 约 10 个不同的快速路径，每条只加载自己需要的模块
- `feature()` 是构建时特性开关，不启用的功能在打包时被彻底删除
- `profileCheckpoint` 记录启动各阶段时间，用于性能优化

## 前后呼应

- 本节的"最终默认路径加载 main.js"，下一节开始就是 `main.tsx` 的故事
- 本节的 `feature()` 特性开关，在 **[7-7 节](./7-7-工具注册表assembleToolPool.md)** 也会看到它控制哪些工具被注册

## 下一节预告

下一节讲 **Commander CLI 参数解析器**——`main.tsx` 第一件事就是解析命令行参数，Commander.js 是怎么工作的？

➡️ [下一节：6-3 Commander：CLI 参数解析器](./6-3-Commander-CLI参数解析器.md)
