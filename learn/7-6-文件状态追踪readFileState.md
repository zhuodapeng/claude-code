# 7-6 文件状态追踪：readFileState 的设计

> **本节目标**：Claude 读了一个文件，然后想编辑它。但用户可能在这两个操作之间手动修改了文件——Claude 编辑的是"过时的版本"。这会导致编辑错位，甚至代码损坏。Claude Code 是怎么检测和处理这个问题的？`readFileState` 是什么，为什么每个工具调用都要带着它？

---

## 问题：Claude 看到的可能是过时版本

想象这个场景：

1. Claude 用 `Read` 工具读了 `src/App.tsx`，内容是 v1
2. 用户在终端里用 `vim` 打开这个文件，做了一些修改，保存，内容变成 v2
3. Claude 用 `Edit` 工具，基于 v1 的内容构造了一个字符串替换请求
4. `Edit` 工具在 v2 上执行这个替换……

如果 v1 和 v2 差异不大，替换可能"成功"了，但结果是错的——Claude 替换的是它"以为"的内容，不是文件现在真实的内容。

这不只是 user 手动修改的问题。Claude 可能在一次响应里调用多个工具：

```
Read("a.ts")     → 读取 a.ts
Edit("b.ts")     → 修改 b.ts（副作用：b.ts 触发了一个 linter，linter 自动格式化了 a.ts）
Edit("a.ts")     → Claude 编辑 a.ts，但 a.ts 已经被 linter 改过了
```

这类问题很难调试——Claude 认为自己的编辑成功了，实际上文件内容已经和它预期的不一样了。

---

## 解法：在每次读操作后，记录"读取时间戳 + 内容"

**文件：[src/utils/fileStateCache.ts](../src/utils/fileStateCache.ts)**

```typescript
export type FileState = {
  content: string    // 读取时的文件内容（用于内容比对）
  timestamp: number  // 读取时的文件修改时间（用于快速检测变化）
  offset: number | undefined   // 是否是部分读取（有 offset/limit 的话只读了一段）
  limit: number | undefined
  isPartialView?: boolean  // 自动注入的内容（CLAUDE.md），模型看到的是裁剪版
}
```

每次 `Read` 工具读取一个文件后，把文件的当前状态（时间戳 + 内容）存入 `readFileState` 缓存。

这个缓存是一个 LRU（最近最少使用）缓存，有两个维度的限制：
- **条目数**：最多 100 个文件
- **字节数**：最多 25MB（避免大文件内容把内存撑爆）

```typescript
export class FileStateCache {
  private cache: LRUCache<string, FileState>
  
  constructor(maxEntries: number, maxSizeBytes: number) {
    this.cache = new LRUCache({
      max: maxEntries,
      maxSize: maxSizeBytes,
      sizeCalculation: value => Math.max(1, Buffer.byteLength(value.content)),
      //                              ↑ 按内容字节数计算 "size"
    })
  }
  
  get(key: string): FileState | undefined {
    return this.cache.get(normalize(key))  // 路径规范化后查找
  }
  
  set(key: string, value: FileState): this {
    this.cache.set(normalize(key), value)
    return this
  }
}
```

### 路径规范化的必要性

注意 `normalize(key)` ——所有路径操作前都规范化。为什么？

Windows 上同一个文件有多种路径写法：

```
C:\Users\foo\src/App.tsx    ← 混用正斜杠和反斜杠
C:/Users/foo/src/App.tsx    ← 全正斜杠
C:\Users\foo\src\App.tsx    ← 全反斜杠
```

如果不规范化，这三个路径会被当作三个不同的缓存键，导致缓存未命中（每次都认为"没读过这个文件"）。

---

## Read 工具：读取后写入缓存

**文件：[src/tools/FileReadTool/FileReadTool.ts](../src/tools/FileReadTool/FileReadTool.ts)**

读取文件后，在 `call()` 的最后更新缓存：

```typescript
async call(input, { readFileState, ... }) {
  const { file_path } = input
  const absolutePath = expandPath(file_path)
  
  // 读取文件内容
  const content = await readFileAsync(absolutePath, 'utf-8')
  const timestamp = getFileModificationTime(absolutePath)
  
  // 存入缓存
  readFileState.set(absolutePath, {
    content,
    timestamp,
    offset: input.offset,    // 如果只读了部分内容，记录范围
    limit: input.limit,
  })
  
  return {
    data: { content: addLineNumbers(content), file_path },
    // ...
  }
}
```

缓存里存的是**磁盘上的原始内容**（不是发给 Claude 的内容，发给 Claude 的版本可能有行号前缀）。这样后续检查文件是否变化时，可以直接用 `===` 比较。

---

## Edit 工具：编辑前检查缓存

**文件：[src/tools/FileEditTool/FileEditTool.ts](../src/tools/FileEditTool/FileEditTool.ts#L275-L311)**

`Edit` 工具的 `validateInput()` 里有关键检查：

```typescript
async validateInput(input, toolUseContext) {
  const { file_path } = input
  const fullFilePath = expandPath(file_path)
  
  // 检查 1：这个文件读过吗？
  const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
  if (!readTimestamp || readTimestamp.isPartialView) {
    return {
      result: false,
      message: 'File has not been read yet. Read it first before writing to it.',
      errorCode: 6,
    }
  }
  
  // 检查 2：文件自读取后是否被修改过？
  const lastWriteTime = getFileModificationTime(fullFilePath)
  if (lastWriteTime > readTimestamp.timestamp) {
    
    // 特殊情况：Windows 上时间戳可能无意义地变化（云同步、杀毒软件）
    // → 如果是全文读取，再比较内容本身
    const isFullRead = readTimestamp.offset === undefined && readTimestamp.limit === undefined
    if (isFullRead && fileContent === readTimestamp.content) {
      // 内容没变，时间戳的变化是假阳性，允许继续
    } else {
      return {
        result: false,
        message: 'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
        errorCode: 7,
      }
    }
  }
  
  // 文件没有变化，可以安全编辑
  return { result: true }
}
```

这是一个**时间戳 + 内容**的双重检查策略：

1. **快速路径**：先比时间戳（O(1)，纯内存操作）
2. **慢速路径**：时间戳变了但可能是假阳性（Windows 的云同步会无端更新时间戳）→ 比较内容（O(n)，但只在必要时）

两阶段检测比单一策略更健壮：时间戳比较快，内容比较准。

---

## 三种检查结果及其背后的设计意图

```
情况 1：文件从未被 Read 过
  → 返回 "File has not been read yet"
  → 原因：Claude 不知道文件的当前内容，编辑是盲目的
  
情况 2：文件被读过，但之后被修改了
  → 返回 "File has been modified since read"
  → 原因：Claude 基于过时内容构造的编辑操作，执行后结果可能是错的
  
情况 3：文件被读过，且没有被修改
  → 允许编辑
```

这个设计强制了一个编辑前置条件：**必须先 Read，才能 Edit**。

从系统设计角度，这是"**乐观锁**"的简化版：不是加锁（会导致阻塞），而是在提交时检查"我读取后有没有人修改过"（检测冲突）。如果有冲突，操作失败，调用方需要重试（让 Claude 重新 Read）。

---

## Edit 后更新缓存

编辑成功后，缓存要更新（因为文件内容和时间戳都变了）：

**文件：[src/tools/FileEditTool/FileEditTool.ts](../src/tools/FileEditTool/FileEditTool.ts#L519-L525)**

```typescript
// 6. 编辑成功，更新读取状态（让后续编辑操作知道当前状态）
readFileState.set(absoluteFilePath, {
  content: updatedFile,              // 编辑后的内容
  timestamp: getFileModificationTime(absoluteFilePath),  // 新时间戳
  offset: undefined,
  limit: undefined,
})
```

这很重要：如果不更新，Claude 在同一个会话里对同一个文件做第二次编辑时，缓存里存的是"第一次编辑之前的内容"，会触发"文件已被修改"的错误。

---

## readFileState 的生命周期

这个缓存是**会话级别**的，不是跨会话持久化的：

```
会话开始
    ↓
创建空的 FileStateCache
    ↓
Read("a.ts") → 缓存 a.ts 的状态
Read("b.ts") → 缓存 b.ts 的状态
Edit("a.ts") → 检查缓存，更新缓存
    ↓
会话结束（或 /clear）
    ↓
缓存清空（下次会话重新开始）
```

注意：这意味着如果用户执行 `/clear`（清空对话历史），文件状态缓存也会被清空。下次 Claude 想编辑某个文件时，需要重新 Read 一遍。这是正确行为——对话历史被清除了，Claude 对文件的"认知"也应该被清除。

---

## isPartialView：CLAUDE.md 的特殊处理

**文件：[src/utils/fileStateCache.ts](../src/utils/fileStateCache.ts#L10-L15)**

```typescript
type FileState = {
  // ...
  isPartialView?: boolean
  // True when this entry was populated by auto-injection (e.g. CLAUDE.md) and
  // the injected content did not match disk (stripped HTML comments, stripped
  // frontmatter, truncated MEMORY.md). The model has only seen a partial view;
  // Edit/Write must require an explicit Read first.
}
```

`CLAUDE.md` 这类文件会被自动注入到 System Prompt——Claude 不需要显式 `Read` 它们就能"看到"它们。

但这里有个陷阱：自动注入的版本可能不是完整的（HTML 注释被剥除、frontmatter 被过滤、MEMORY.md 有截断限制）。如果 Claude 基于"自动注入的不完整视图"去编辑文件，可能会把系统剥除的部分也删掉。

解决方法：`isPartialView: true` 标记的缓存条目，被 Edit 工具视为"没有读过"——Claude 必须显式 `Read` 一遍完整内容，才能编辑。

---

## 跨 Agent 的缓存合并

子 Agent 有独立的 `readFileState` 缓存（避免状态污染）。当子 Agent 完成并返回时，父 Agent 需要把子 Agent 的读取状态合并回来：

**文件：[src/utils/fileStateCache.ts](../src/utils/fileStateCache.ts#L129-L142)**

```typescript
export function mergeFileStateCaches(
  first: FileStateCache,
  second: FileStateCache,
): FileStateCache {
  const merged = cloneFileStateCache(first)
  for (const [filePath, fileState] of second.entries()) {
    const existing = merged.get(filePath)
    // 只用更新的条目覆盖（时间戳更大的赢）
    if (!existing || fileState.timestamp > existing.timestamp) {
      merged.set(filePath, fileState)
    }
  }
  return merged
}
```

合并规则：**时间戳更大的记录赢**。因为时间戳代表"更新的状态"，用新状态覆盖旧状态是正确的。

---

## 为什么不直接每次读磁盘？

看到这里，你可能想问：为什么不在 Edit 时直接重新读磁盘，和 Claude 提供的 `old_string` 比对？

两个原因：

1. **性能**：每次编辑都需要一次磁盘 I/O。`FileStateCache` 把这个检查变成了纯内存操作（快 100x）。

2. **时机问题**：`validateInput()` 在权限检查之前运行（见 7-5 节），此时还没有完整的工具执行上下文。缓存查找是同步的，磁盘读取是异步的——把异步操作放进同步的验证路径会使代码复杂化。

---

## 本节小结

- `readFileState`（`FileStateCache`）是一个 LRU 缓存，记录每个读取过的文件的内容和时间戳
- `Edit` 工具的 `validateInput()` 在真正执行前检查：文件是否被读过？读后是否被修改？
- 使用"时间戳 + 内容"双重检查：时间戳快但不完全可靠（Windows 假阳性），内容比较可靠但慢
- 这是乐观锁思想的应用：不加锁，而是在"提交"时检测冲突
- `isPartialView` 标记处理了自动注入文件（CLAUDE.md）被裁剪的问题——裁剪版不算"读过"
- 子 Agent 有独立缓存，完成后按时间戳合并回父 Agent

## 前后呼应

- 本节的 `readFileState`，是 **[7-1 节](./7-1-Tool的本质为什么Claude需要工具.md)** 里 `ToolUseContext` 的一个字段，现在你知道它具体存储什么了
- 本节的验证逻辑位于 `validateInput()` 中，在 **[7-5 节](./7-5-权限检查工具执行前的守门人.md)** 提到了 `validateInput()` 和 `checkPermissions()` 的区别

## 下一节预告

工具数量超过 40 个，如果全部发给 Claude 会消耗大量 token。ToolSearch 机制如何实现"按需加载"工具定义？

➡️ [下一节：7-7 ToolSearch：工具定义的懒加载](./7-7-ToolSearch懒加载机制.md)
