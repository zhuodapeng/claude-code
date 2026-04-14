# 6-1 入口脚本：bin/claude-haha 做了什么

> **本节目标**：理解从你在终端输入 `claude-haha` 到 Bun 开始执行 TypeScript 的整个过程，以及入口脚本的关键设计决策。

---

## 从命令到进程的完整路径

当你在终端输入 `claude-haha` 并按下 Enter，操作系统要做一系列工作：

```
终端：claude-haha

    ↓  操作系统查找命令
    
PATH 里找到 /path/to/bin/claude-haha

    ↓  读取第一行（shebang）
    
#!/usr/bin/env bash
→ 用 bash 解释器执行这个脚本

    ↓  脚本执行
    
exec bun --env-file=.env ./src/entrypoints/cli.tsx
→ Bun 进程替换当前 shell 进程，开始执行 TypeScript
```

整个过程看似简单，但 `bin/claude-haha` 脚本里有几个值得细看的设计决策。

---

## 完整脚本解析

**文件：[bin/claude-haha](../bin/claude-haha#L1-L17)**

```bash
#!/usr/bin/env bash
set -euo pipefail                          # 严格模式

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# ↑ 找到项目根目录（bin/ 的上一级）
# BASH_SOURCE[0] 是当前脚本的路径，不管你从哪里调用

export CALLER_DIR="$(pwd -W 2>/dev/null || pwd)"
# ↑ 记录用户调用命令时所在的目录（非常重要！）
# 用户在 /home/user/myproject/ 里运行 claude-haha
# Claude 需要知道这个目录，而不是 claude-haha 自己在哪里
# pwd -W 是 Windows 兼容写法，失败时 fallback 到 pwd

cd "$ROOT_DIR"
# ↑ 切换到项目根目录
# 这样 Bun 运行时能正确解析相对路径的 import

# 路径一：Recovery CLI（降级模式）
if [[ "${CLAUDE_CODE_FORCE_RECOVERY_CLI:-0}" == "1" ]]; then
  exec bun --env-file=.env ./src/localRecoveryCli.ts "$@"
fi

# 路径二：正常启动（默认）
exec bun --env-file=.env ./src/entrypoints/cli.tsx "$@"
```

---

## `set -euo pipefail`：脚本的安全模式

这一行开启了三个严格模式：

- **`-e`**：任何命令失败（exit code 非 0）立即退出脚本
- **`-u`**：使用未定义的变量时报错并退出（而不是静默使用空字符串）
- **`-o pipefail`**：管道中任何命令失败都算失败（而不是只看最后一个命令）

**为什么重要**：

```bash
# 没有 set -e：
rm -rf "$SOME_UNDEFINED_VAR/important_files"
# 如果 SOME_UNDEFINED_VAR 没定义，等价于 rm -rf "/important_files"（灾难！）

# 有 set -u：
# 直接报错退出，不执行危险操作
```

---

## `CALLER_DIR`：用户的工作目录

这是一个容易被忽略但极其重要的细节。

**问题**：Claude Code 是安装在某个位置的工具（比如 `/usr/local/bin/claude-haha`），但用户在自己的项目目录里使用它（比如 `/home/user/myproject`）。

Claude 需要知道**用户的项目目录**，而不是 Claude Code 自己的安装位置。

```
用户操作：
  cd /home/user/myproject
  claude-haha "帮我分析这个项目"
  
  ↓  bash 开始执行 bin/claude-haha
  
  此时：
    $PWD = /home/user/myproject        ← 用户的目录（正确！）
    BASH_SOURCE[0] = .../bin/claude-haha  ← 脚本位置
  
  CALLER_DIR="$(pwd)" = /home/user/myproject  ✅
  
  cd "$ROOT_DIR"  ← 切换到 Claude Code 的安装目录
  
  此时 $PWD 变了，但 CALLER_DIR 已经保存了用户的目录
  
  ↓  Bun 启动，CALLER_DIR 作为环境变量传入
  
  TypeScript 代码读取 process.env.CALLER_DIR
  → 知道要操作 /home/user/myproject 这个项目
```

你会在 `src/utils/cwd.ts` 里看到：

```typescript
export function getCwd(): string {
  return process.env.CALLER_DIR || process.cwd()
}
```

这个 `getCwd()` 在整个项目里被频繁调用——System Prompt、文件操作、权限检查……全都依赖正确的工作目录。

---

## `exec`：进程替换，不是子进程

注意脚本最后用的是 `exec`，不是直接调用：

```bash
exec bun --env-file=.env ./src/entrypoints/cli.tsx "$@"
```

**`exec` vs 普通调用的区别**：

```bash
# 普通调用：创建子进程
bun ...
# bash 进程（PID 100）继续存在
# bun 进程（PID 101）是它的子进程

# exec：替换当前进程
exec bun ...
# bash 进程（PID 100）被 bun 进程取代
# bun 进程的 PID 还是 100
```

**为什么用 `exec`？**

1. **信号处理**：用户按 Ctrl+C 时，终端向进程组发送 SIGINT。如果是父子进程，信号可能被 bash 进程拦截；用 exec 替换后，信号直接发给 bun 进程，更可靠。

2. **资源效率**：不需要保留一个空的 bash 进程在内存里等待 bun 结束。

3. **退出码透传**：bun 的退出码直接就是整个命令的退出码。

---

## `$@`：传递所有命令行参数

```bash
exec bun --env-file=.env ./src/entrypoints/cli.tsx "$@"
```

`"$@"` 把调用 `claude-haha` 时传入的所有参数原封不动地转发给 Bun：

```bash
claude-haha --version         →  bun ... cli.tsx --version
claude-haha --model opus      →  bun ... cli.tsx --model opus
claude-haha "你好"             →  bun ... cli.tsx "你好"
```

加引号的 `"$@"` 确保参数里的空格被正确处理（不加引号的 `$@` 会在空格处分割参数）。

---

## `--env-file=.env`：Bun 原生环境变量注入

这是 Bun 的特有功能（Node.js 没有）。

Bun 在启动时读取 `.env` 文件里的键值对，自动注入为环境变量：

```
.env 文件内容：
ANTHROPIC_API_KEY=sk-ant-xxxxx
CLAUDE_MODEL=claude-sonnet-4-6

等价于：
export ANTHROPIC_API_KEY=sk-ant-xxxxx
export CLAUDE_MODEL=claude-sonnet-4-6
```

TypeScript 代码里通过 `process.env.ANTHROPIC_API_KEY` 读取。

**不需要 `dotenv` 库**，这是 Bun 相比 Node.js 的一个实用优势。

---

## Recovery CLI：优雅降级

```bash
if [[ "${CLAUDE_CODE_FORCE_RECOVERY_CLI:-0}" == "1" ]]; then
  exec bun --env-file=.env ./src/localRecoveryCli.ts "$@"
fi
```

**什么时候需要 Recovery CLI？**

Ink TUI 依赖终端的特定能力（ANSI 转义码、Unicode 等）。在某些环境下可能失效：
- 某些 CI 环境（非交互式终端）
- 不支持特殊字符的终端
- 远程连接的终端兼容性问题
- TUI 代码本身有 bug 导致崩溃

`CLAUDE_CODE_FORCE_RECOVERY_CLI=1` 让用户可以绕过 TUI，降级到简单的 readline REPL，保证基本功能可用。

**`localRecoveryCli.ts`** 是一个极简的问答接口：没有颜色、没有流式输出，就是最朴素的"输入→等待→输出"循环。

---

## 本节小结

- `bin/claude-haha` 是一个 bash 脚本，捕获用户工作目录，然后用 `exec` 启动 Bun
- `set -euo pipefail` 开启严格模式，防止危险的静默失败
- `CALLER_DIR` 保存用户的工作目录，在 cd 到项目根目录之前
- `exec bun` 替换当前进程（不创建子进程），信号处理更可靠
- `--env-file=.env` 是 Bun 原生的环境变量注入，不需要 dotenv
- `CLAUDE_CODE_FORCE_RECOVERY_CLI=1` 提供降级路径，绕过 Ink TUI

## 前后呼应

- 本节的 `CALLER_DIR` 和 `getCwd()`，在 **[8-3 节](./8-3-System-Prompt的构建.md)** 会看到它如何注入 System Prompt
- 本节的 Recovery CLI，在 **[4-3 节](./4-3-终端渲染的限制与取舍.md)** 已经提到它的存在原因

## 下一节预告

下一节讲 **cli.tsx 的设计思路**——这个文件是 Bun 实际执行的第一个 TypeScript 文件，它用了一个精妙的"快速路径"优化来提升启动速度。

➡️ [下一节：6-2 快速路径优化：cli.tsx 的设计思路](./6-2-快速路径优化cli-tsx的设计思路.md)
