# dsh-remote-worktree — 设计

状态：设计草案 v1 · 2026-09-10 · 仓外 bundle 插件

## 0. 一句话

一个仓外 DSH bundle 插件：本地侧接管 `ctx.fs` / `ctx.subprocess` / `ctx.shell` 做**路由**，远端侧在每台机器上跑一个**自建 node sidecar**；在远端仓库里创建 `git worktree`，本地为它建一个**锚点目录**以获得工作区身份，从而让 `read` / `write` / `edit` / `bash` / `grep` 这些**原样工具**真正跑在远端。

### 术语

| 词 | 含义 |
|---|---|
| **出厂实现** | DSH 自带、未经改动的实现类：`dsh-fs-sandbox`（`SandboxedFileSystem`）、`dsh-subprocess-local`（`LocalSubprocessRuntime`）、`dsh-bash-sandbox`（`SandboxBashExecutor`）。 |
| **sidecar** | 跑在每台远端机器上的守护进程 `dsh-remote-agent`；纯 Node 程序，不依赖 DSH，也不依赖 Cordis。 |
| **wire** | 本地插件与 sidecar 之间的协议层（JSON-RPC over TCP/TLS），与 DSH 内部机制无关。 |
| **锚点（anchor）** | `$DSH_HOME/remote-worktrees/...` 下一个真实的本地空目录，只放元数据；用它给远端 worktree 一个本地工作区身份。 |
| **组合** | 持有出厂实现的一个实例并委托调用。与之相对的**继承**是 `extends` 它并调用 `super()`；本设计只用前者。 |

## 1. 目标与非目标

**目标**

1. 机器（下文称 **node**）注册、连接、断开、删除，Web 端可管理。
2. 远端目录浏览，用于选工作目录。
3. 在远端仓库创建 / 删除远端 `git worktree`，本地建锚点并注册成 workspace。
4. 路由 `ctx.fs` / `ctx.subprocess` / `ctx.shell`：模型工具**零增量**，本地会话行为不变。
5. Web 端把某个远端 worktree **打开成会话**。

**非目标（v1）**

- 不走 SSH（已定：远端安装 server）。
- 不把 DSH harness 搬到远端——harness、模型调用、会话日志仍全在本地。
- 不做文件镜像 / 双向同步：锚点目录只有元数据，没有文件副本。
- 不做多租户。sidecar 以安装它的用户身份运行，拥有该用户的全部文件权限，**它不是沙箱**。
- v1 不支持常驻 PTY 会话（见 §10 与 §12）。

## 2. 为什么自建 sidecar 而不是 SSH

| 维度 | SSH（ssh2） | 自建 sidecar |
|---|---|---|
| 远端依赖 | 无 | 需安装 / 升级 |
| PTY、前台进程组、整会话静默 | 纯 JS 做不到 | 原生（node-pty） |
| 字节精确 IO、大文件窗口读 | 受 SFTP 约束 | 自定义帧 |
| 原子写、版本守卫、结构化错误码 | 要自己拼 | **直接复用 DSH 语义** |
| 进程树清理、进程身份围栏 | 弱 | 自己实现（沿用 DSH 契约的托管范围语义） |
| 信任面 | 复用既有 SSH 密钥 | 新增 token + 监听端口 |

**路线选择（已定：不继承实现类；该复用的复用，该自写的自写）**：

- **本地分支 → 组合。** 接口完全相同（同一个抽象 Service）、委托 1:1，这不是强行复用，是最省的写法。机制是 Cordis 的**隔离子作用域**：`ctx.isolate('<服务名>')` 返回一个该服务名解析独立的子上下文，把出厂实现（`dsh-fs-sandbox` / `dsh-subprocess-local` / `dsh-bash-sandbox`）当 plugin 挂进去，再取出实例持有——既原样复用语义，又不与宿主自己的 `ctx.fs` 撞名。
- **远端 daemon → 自己写。** 为了复用而把 Cordis + `dsh-fs-local` + `dsh-subprocess-local` 拖到每台远端机器上，才是真正的强行复用：远端要装一整套 DSH、跟随 DSH 版本漂移，而它本来只需要一个能读写文件、能起进程的守护进程。**远端 daemon 是纯 Node 程序，不依赖 Cordis，也不依赖任何 `@deepseek-ai/dsh-*`。**

| 位置 | 做法 | 判断依据 |
|---|---|---|
| 远端 daemon · fs | 自己写（`node:fs/promises` + temp/rename 原子发布） | 约 400 行，可控，不值得为它拖一整套 DSH 上远端 |
| 远端 daemon · subprocess | 自己写（`node:child_process` + `node-pty`） | 全项目最贵的一块，见 §4.4 |
| 本地 · fs | 组合 `SandboxedFileSystem` | 沙箱围栏、原子写、版本守卫、跨 chunk 解码全部白拿 |
| 本地 · subprocess | 组合 `LocalSubprocessRuntime` | 托管进程范围、TERM→KILL、采集与 spill、PTY 全部白拿 |
| 本地 · shell | 组合 `SandboxBashExecutor` | 本地 bash 的沙箱 argv 与请求/规格分离 |

**连接缝定义也不用继承。** `Service` 的构造函数内部做的就是把实例交给 `ctx.reflect.provide(name, self)`（`vendor/cordis/src/service.ts`）——所以 `ctx.provide('fs', 普通对象)` 是同一个原语的直接调用，是 Cordis 的公开 API，不需要子类。三个路由 provider 因此都是**普通对象**：

```ts
// 只用于编译期检查；import type 不产生运行时耦合
type FileSystemContract = Pick<FileSystem,
  | 'resolve' | 'processPath' | 'fileUrl' | 'contains'
  | 'stat' | 'lstat' | 'listDir'
  | 'readText' | 'streamText' | 'readBytes' | 'readByteRange'
  | 'writeText' | 'editText' | 'sandboxMode'>

const router = {
  resolve, processPath, fileUrl, contains,
  stat, lstat, listDir, readText, streamText,
  readBytes, readByteRange, writeText, editText,
  get sandboxMode() { return undefined },
} satisfies FileSystemContract

const dispose = ctx.provide('fs', router as unknown as FileSystem)
ctx.effect(() => dispose)        // 随插件卸载自动注销
```

同样的模式用于 `ctx.provide('subprocess', …)` 与 `ctx.provide('shell', …)`。

代价与残余风险只有三条：

1. **一次 cast**：`FileSystem` 继承自 `Service`，而 `Service` 有 `protected ctx` 等成员，TypeScript 因此按名义类型判定，普通对象无法直接赋值给 `FileSystem`。上面的 `Pick` 契约先给出完整的编译期检查，再在注册那一行 cast 一次。
2. **拿不到 `Service` 的附加机制**（callable 包装、`tracker.associate = 'ctx'`、mixin、`static Config`/`static inject` 约定）。已核实：`fs` / `subprocess` / `shell` 三条接缝上没有任何 mixin、`Service.extend`、`accessor` 用法，也没有 `instanceof` 检查；插件按函数插件（`name` / `inject` / `Config` / `apply`）声明自己的配置与依赖。
3. **释放要自己接**：`provide` 返回 disposer，必须包进 `ctx.effect()`；继承这条路是免费的。

换来的是零继承、零运行时耦合（`import type` 只带类型），以及 `ctx.fs` / `ctx.subprocess` / `ctx.shell` 三个键由普通对象提供。

**必须自己写的四块**：远端 daemon 本体（含 fs/subprocess 实现）、远端 RPC 往返与 `spawn(spec)` 同步契约之间的**代理 handle**（§5.2，全项目最难）、路由分类与二义性（§5.6）、节点注册表 / 锚点 / Web / UI 业务逻辑。

代价还要写明白：多了一个需要部署、升级、授权和卸载的守护进程，多了一条常驻监听端口，且它的权限等于安装用户。

## 3. 总体架构

```
┌──────────────────────── 本地 dsh（web profile）────────────────────────┐
│  模型工具（原样，零改动）                                                │
│    tool-fs  tool-bash  tool-fs-search  tool-terminal  tool-lsp         │
│         │        │            │              │            │            │
│         ▼        ▼            ▼              ▼            ▼            │
│   ┌──────────────────────────────────────────────────────────────┐    │
│   │ RoutingFileSystem   RoutingBashExecutor   RoutingSubprocess   │    │
│   │  (ctx.fs)             (ctx.shell)           (ctx.subprocess)  │    │
│   │     │                     │                        │          │    │
│   │     ├─ 本地路径 ──────────┴────────────────────────┴──► 本地实现      │    │
│   │     │                    （组合的出厂实现，隔离作用域内）          │    │
│   │     └─ 锚点/远端路径 ──► NodeClient（JSON-RPC 行协议）          │    │
│   └──────────────────────────────────┬───────────────────────────┘    │
│   NodeRegistry（durable）  AnchorStore   WebController（webServer）    │
│   client 半边：settings.section + 目录流 occupant + 会话头徽章          │
└──────────────────────────────────────┼────────────────────────────────┘
                                       │ tcp:// (loopback 或隧道；可选 TLS)
┌──────────────────────────────────────▼────────────────────────────────┐
│  远端 dsh-remote-agent（Node 进程，以安装者身份）                        │
│    JSON-RPC 分发 →  自实现 fs / subprocess（node:fs + child_process + pty）│
│                      （纯 Node，无 Cordis、无 @deepseek-ai/dsh-* 依赖）    │
│    runtimeRoot/<spill,procs,terms>   git worktree 操作                 │
└───────────────────────────────────────────────────────────────────────┘
```

## 4. 远端 sidecar

### 4.1 形态与安装

- npm 包 `dsh-remote-worktree-agent`，`bin: dsh-remote-agent`。
- **纯 Node 程序**：不依赖 Cordis，不依赖任何 `@deepseek-ai/dsh-*`。远端只需 Node ≥ 22 与这个包。这是刻意的——把 DSH 拖到每台远端机器上换取代码复用，会让远端跟随 DSH 版本漂移，而远端本来只需要读写文件和起进程。
- 启动：`dsh-remote-agent --listen 127.0.0.1:7801 --token-file ~/.dsh-remote/token --root ~/work`。
- 默认监听 **loopback**；对外暴露由用户自己的隧道负责（WireGuard、`ssh -L`、cloudflared）。这跟 DSH 自身 Web 服务只绑 `127.0.0.1` 的姿态一致。
- **只能装包，不能单文件 bundle**：PTY 依赖 `node-pty`（原生模块），塞不进单个 `.mjs`。所以 sidecar 的安装形态就是 `npm i -g`（或远端项目内安装），本设计不提供无依赖降级形态。若将来确实需要无依赖形态，只能砍掉 PTY 能力并在握手声明 `capability.pty = false`。
- 卸载：`dsh-remote-agent --uninstall` 打印它写过的路径与 token 文件位置；插件只负责提示，不远程删文件。

### 4.2 协议

JSON-RPC 2.0，**换行分隔的 JSON 行**，跑在一条 TCP/TLS 长连接上，复用全部请求。传输层不自己写：用 `vscode-jsonrpc`（微软维护、LSP 的事实标准、零运行时依赖），它提供请求关联、通知、取消与流式消息，架在任意 `Readable` + `Writable` 上。二进制一律 base64。

握手：`hello { protocol: 1, agentVersion, capability: { pty, ripgrep, spill } }`。协议版本不匹配**直接 fail loud**，不做降级兼容。

**关键设计：输出用「按字节偏移拉取」，不做推送流。**

DSH 的 `SubprocessOutputReader` 本来就是游标无关、按 `fromByte` 拉取的；把这个语义原样搬到 wire 上，客户端和 sidecar 都不需要维护推送缓冲、背压和帧序号。

| 方法 | 参数 | 返回 |
|---|---|---|
| `fs.resolve` | `{ path, cwd? }` | `{ targetKey, canonicalPath }` |
| `fs.stat` | `{ targetKey }` | `FsInfo \| null` |
| `fs.lstat` | `{ path, cwd? }` | `FsPathInfo \| null` |
| `fs.readBytes` | `{ targetKey, maxBytes }` | `{ data: base64 }` |
| `fs.readByteRange` | `{ targetKey, offset, length }` | `{ data: base64 }` |
| `fs.readTextChunk` | `{ targetKey, offset, length }` | `{ text, nextOffset, eof, lossy }` |
| `fs.listDir` | `{ targetKey }` | `FsDirEntry[]`（targetKey 已加节点前缀） |
| `fs.writeText` | `{ targetKey, content, expected? }` | `FsWriteOutcome` |
| `fs.editText` | `{ targetKey, edit, expected? }` | `FsEditOutcome` |
| `sp.resolveExecutable` | `{ command, env? }` | `{ path }` |
| `sp.spawn` | `{ argv, cwd, stdio, graceMs, env? }` | `{ procId }` |
| `sp.readOutput` | `{ procId, stream, fromByte }` | `SubprocessOutputRead` |
| `sp.writeStdin` / `sp.closeStdin` | `{ procId, data? }` | `{}` |
| `sp.terminate` | `{ procId }` | `{}` |
| `sp.waitForExit` | `{ procId }` | `{ empty: boolean }` |
| `sp.outcome` | `{ procId }` | `SubprocessOutcome \| null` |
| `node.stat` | `{}` | `{ platform, arch, homedir, rgPath, load }` |
| `git.worktreeAdd/List/Remove` | 见 §7 | — |

三个必须讲清楚的映射：

1. **`FsTargetKey` 是服务端生成的**。sidecar 侧沿用 `fs-local` 的 realpath 键；本地路由 provider 组合成 `node:<nodeId>:<canonicalPath>`。`contains(parent, child)`、`processPath`、`fileUrl` 全部由**本地**从复合键算出，不需要一次 RPC。注意复合键是路由 provider 自己造的，它有权解析自己的键（seam 只禁止 Consumer 解析）。
2. **文本流的解码与二进制判定留在 sidecar**（seam 明确要求 backend 拥有跨 chunk UTF-8 解码与二进制拒绝），所以是 `fs.readTextChunk` 而不是裸字节。
3. **`stdin: 'pipe'` 与两处 `stdout/stderr: { spill }`**：
   - `'ignore'` / `{data}` 直接映射。
   - `'pipe'` 需要一个推送通道（它要喂一个 `Readable` 给 LSP / 子进程 CLI 协议解码）。设计上**只对 `'pipe'` 模式开推送帧**，服务端保留有界窗口 + seq，客户端按窗口 ack。
   - `spillPath` 是 sidecar 本地路径。v1 把 spill 写在 `<runtimeRoot>/spill/<procId>` 并把它作为一个**保留锚点**暴露给本地，使 `spillPath` 能被同一套路由 `fs` 读回；只在握手声明 `capability.spill` 时启用，否则返回 `truncated` 且无 `spillPath`。

### 4.3 认证与传输

- **token**：插件生成 32 字节随机串，本地存 profile storage，远端写 `--token-file`（权限 600）。每次连接在 `hello` 之后带 `Authorization` 帧，失败即断。
- **传输**：默认 loopback 明文 `tcp://`，由隧道提供机密性与完整性；跨网必须 `tls://`（`node:tls`，自签证书指纹 pin 在 node 记录里）。**默认拒绝 `0.0.0.0`**，需要显式开关，且打开时强制要求 TLS + token。
- **审计**：sidecar 侧对每个 `sp.spawn` 与每次远端写追加 JSONL 审计（时间 · 用户 · 操作 · 退出码 · 命令），本地可经 `node.audit` 拉取。

### 4.4 远端要自己实现什么（工作量清单）

| 能力 | 实现要点 | 量级 |
|---|---|---|
| `resolve` / `stat` / `lstat` / `listDir` | `node:fs/promises` + `realpath` 规范化目标键 | 小 |
| `readText` / `streamText` | `TextDecoder` 增量解码；NUL 与非法序列判二进制 | 小 |
| `readBytes` / `readByteRange` | `open` + 窗口读，超 `maxBytes` 报 `FS_TOO_LARGE` | 小 |
| `writeText` / `editText` | temp + `rename` 原子发布；版本 token 取 `mtimeMs`/`size`/`ino`；字面替换与歧义判定 | 中 |
| `resolveExecutable` | 远端 PATH 查找 + 绝对路径校验 | 小 |
| `spawn` | stdio 三态、有界采集与 spill、托管进程范围、TERM→KILL 阶梯、`waitForExit` | **大** |
| `spawnTerminal` | `node-pty` 分配、前台进程组、信号投递、整会话静默 | **大** |

诚实提示：`spawn` 与 `spawnTerminal` 是全项目最贵的两块，也正是生态里两个同形态插件各自留下公开缺陷的地方（`dsh-worlds` 的 `stdin: 'pipe'` 未实现、`neev-sandbox` 的版本 token 只能从 mtime/size/mode 派生）。v1 可把 `spawnTerminal` 放到 P4，握手先声明 `capability.pty = false`。

## 5. 本地侧：路由

三个路由 provider 都是**普通对象**（不继承任何类），各自**组合**一个挂在自己隔离子作用域里的出厂实现，并通过 `ctx.provide` 注册。本地分支把调用委托给那个实例，远端分支走 RPC——没有 `extends`、没有 `super()`，也没有一份被复制的实现逻辑。

```ts
// 组合的模式：把出厂实现挂进一个"该服务名解析独立"的子上下文
const scope = ctx.isolate('fs')
scope.plugin(SandboxedFileSystem, config)
const localFs = scope.fs          // 持有实例，本地分支委托给它
```

### 5.1 RoutingFileSystem —— `ctx.fs`

组合 `SandboxedFileSystem`（它自己继承 `fs-local`）。子上下文继承父级的 `sandboxPolicy`，`SandboxedFileSystem` 的 `inject = ['sandboxPolicy']` 因此自动满足，不需要额外装配。

```
resolve(path, opts):
  key = classify(path, opts.cwd)          // 见 §5.6
  if key.kind === 'local'  → localFs.resolve(path, opts)
  if key.kind === 'remote' → rpc fs.resolve → targetKey = `node:${id}:${canonicalPath}`
  if key.kind === 'ambiguous' → throw FsError(FS_IO_ERROR, 二义性说明)

writeText / editText:
  远端 target → 先按远程策略判定（§5.5），再 rpc；FsWriteOutcome 原样透传
  本地 target → localFs.writeText(...)（沙箱围栏、原子写、版本守卫照旧）
```

其余方法按 `targetKey` 前缀分流：本地交给 `localFs`，远端交给 RPC。远端读文本用 `fs.readTextChunk` 拉取循环，**解码与二进制判定发生在远端**，本地不重复实现。

### 5.2 RoutingSubprocessRuntime —— `ctx.subprocess`

组合 `LocalSubprocessRuntime`。分流键是 **`spec.cwd`**：本地分支直接 `localProc.spawn(spec)` / `localProc.spawnTerminal(spec)`，托管进程范围、TERM→KILL 阶梯、采集与 spill、PTY 一行都不用重写。

**这是全设计唯一无法用组合消除的难点：`spawn(spec)` 契约同步返回 handle，而远端启动必须一次往返。** 解法（E2B provider 已验证同一形状）：

1. 同步返回一个**代理 handle**，立即建好 `stdin`（`PassThrough`）/ `stdout` / `stderr` / `collected` 读取器；`terminate()`、`waitForExit()`、`readFrom()` 在远端 ready 之前**排队**而不是失败。
2. 后台发起 `sp.spawn`；成功则把 `procId` 绑定到代理，失败则让 `done` reject（spawn 失败语义不变）。
3. `collected` 读取器把 `fromByte` 直接映射到 `sp.readOutput`；因为远端是**非消费式**的，多次读、独立读都不会互相吃掉输出。
4. `waitForExit` 映射到 `sp.waitForExit`（远端在**自己的托管进程范围**清空后返回）。

采集模式的 `spill` 见 §4.2 第 3 条。

### 5.3 RoutingBashExecutor —— `ctx.shell`

组合 `SandboxBashExecutor`。`bash-sandbox` 会把 argv 交给**本地** `ctx.sandbox` 包一层 bwrap/Seatbelt，再交给 `ctx.subprocess`；远端 cwd 下这会把 bwrap 的 argv 发到远端，必须绕开。

```
RoutingBashExecutor.run/start(spec):
  spec.cwd 是远端 → 不调用 ctx.sandbox，直接 ['bash','-c',command] 经 RoutingSubprocessRuntime
                     （机器本身就是边界）
  spec.cwd 是本地 → localShell.run(spec)（沙箱 argv 与请求/规格分离照旧）
```

`bash-local` 只依赖 `ctx.subprocess`，**不需要替换**；只有 `bash-sandbox` 这一行被本 provider 取代。

### 5.4 ripgrep 改写集中在路由层

`tool-fs-search` 从**主机**解析 ripgrep 二进制（`process.execPath` 旁挂的 `@vscode/ripgrep`）然后经 `ctx.subprocess` 启动。远程 cwd 下这个绝对路径不存在。

不要改 `tool-fs-search`：在 `RoutingSubprocessRuntime.spawn` 里做一次集中的 argv[0] 改写——**当 cwd 是远端且 argv[0] 解析到已知的打包 ripgrep 时，替换为配置的 `remoteRipgrep`（默认 `rg`）**。同时 `sp.resolveExecutable` 在远端做一次存在性检查，缺失时抛出可诊断的错误而不是让 ripgrep 静默失败。

### 5.5 sandbox-policy 的两侧映射

`ctx.sandboxPolicy` 是**部署级单值**（一个 `mode` + 一个 `workspaceRoot`），无法表达「本地受围栏、远端另算」。因此路由层自己实现远程侧映射：

| 模式 | 本地分支 | 远端分支 |
|---|---|---|
| `read-only` | 委托 `localFs`（`fs-sandbox` 围栏） | 拒绝一切远端写 |
| `workspace-write` | 委托 `localFs`（`fs-sandbox` 围栏） | 只允许写在该锚点的**远端根**与其下，外加远端 `/tmp` |
| `danger-full-access` | 不调用 `ctx.sandbox` | 允许 |

判定基准是**锚点元数据里的远端根**，不是 `policy.workspaceRoot`（那是本地路径，会把所有远端写拒掉）。同时 `FileSystem.sandboxMode` 诚实上报。

### 5.6 路由键与二义性（必须写死的规则）

模型看到的 cwd 是锚点路径还是远端路径，决定了它会用哪种拼写调用工具。两种都会出现，所以 `classify()` 必须同时接受：

1. **锚点路径前缀**（`$DSH_HOME/remote-worktrees/<node>/<repo>/<name>/…`）→ 明确命中该 node。
2. **远端绝对路径前缀**，当且仅当它落在**恰好一个**已激活锚点的远端根之下。

规则：

- 命中多个锚点（两台机器都有 `/home/u/proj`）→ **抛出二义性错误**，提示改用显式形式 `node:<nodeId>:<path>`。
- 命中零个 → 本地。
- 显式 `node:<nodeId>:<path>` 形式永远优先，且 `resolve` 必须保证 `resolve(processPath(t)) === t`，即两种拼写解析到同一个 `targetKey`。

## 6. 锚点目录与工作区身份

`workspaceRegistry.create(path)` 要求路径**存在、是目录、realpath 一致**，`SessionHeader.cwd` 也必须是本地存在目录。所以远端 worktree 需要一层本地身份：

```
$DSH_HOME/remote-worktrees/<nodeId>/<repoBase>/<worktreeName>/
├── .dsh-remote-worktree.json     # { version, nodeId, remotePath, repoPath, branch, createdAt }
└── （无文件副本）
```

- **锚点路径就是会话 cwd**，这样 `workspaceRegistry`、`sessionPersistence`、`fs.realpath` 校验、`api/workspace-files` 的会话寻址全部不用改。
- **模型可见 cwd 覆写为远端路径**，用 `ctx.systemPrompt.variable('cwd', …)` 在 agent 作用域注册（该变量表支持按层覆盖，返回 disposer）。这是把「模型以为自己在哪」与「本地身份在哪」分开的关键扩展点。
- 相对路径天然可用：`ctx.fs.resolve(rel, { cwd: anchor })` → 命中规则 1 → 远端。
- 锚点被删除时它对应的规则 2 前缀同时失效，不会留下半活的路由。

**已知脆弱点**（要写进 README 的限制，而不是藏起来）：cwd 变量覆写只影响模型看到的值；若模型仍然输出锚点路径，规则 1 会兜住，行为正确但会话里会出现本地路径，观感不一致。客户端能做路径显示替换（把锚点显示为远端路径），但那依赖未声明的 DOM 结构，属于纯显示层，坏了不影响功能。

## 7. 远端 worktree 生命周期

在远端仓库执行，经 `sp.spawn` 调用远端 git：

```
git -C <repo> worktree add -b worktree/<name> <repo>/.dsh-worktrees/worktree/worktree/<name>
```

| 操作 | 远端 | 本地 |
|---|---|---|
| **create** | `worktree add -b` + 写 per-repo manifest | 建锚点目录 + 写元数据 + `workspaceRegistry.create` |
| **list** | `worktree list --porcelain` + manifest | 列出锚点与其 workspace 状态 |
| **remove** | `worktree remove [--force]` + `branch -D` | 注销 workspace + 删锚点目录 |
| **bring-back** | 在远端 `git merge` 该分支回主分支 | 提示清理命令 |
| **close** | 断开该 node 连接（可选：保留远端进程） | 注销锚点、保留磁盘内容与 manifest |
| **open** | 复用既有连接 | `workspaceRegistry.resolveByPath` → 在 GUI 打开成会话 |

命名空间必须与已在用的 `dsh-task-worktree` 隔开：模型工具用 `rw_*` 前缀，人类命令用 `/rwt`（`/rwt create|list|remove|bring-back|open|close`）。**不要复用 `worktree_create`**，两个插件会撞名。

## 8. 管理面：Web CRUD

### 8.1 host 半边

用 `ctx.webServer.register({ method, path, handler })` 开自己的命名空间（第三方插件可用的既有 API，`dsh-remote` 的 `/dsh-remote/machines` 就是先例）：

```
GET    /dsh-remote-worktree/nodes              列表（不回传 token，只回 hasToken；状态含动态 localPort）
POST   /dsh-remote-worktree/nodes              新增（ssh: {target, port?, identityFile?}, remotePort, token）
PATCH  /dsh-remote-worktree/nodes/:id          改（含改 ssh 目标，保留 nodeId）
DELETE /dsh-remote-worktree/nodes/:id          删（连带注销其仓库登记）
POST   /dsh-remote-worktree/nodes/:id/connect      连接
POST   /dsh-remote-worktree/nodes/:id/disconnect   断开
GET    /dsh-remote-worktree/nodes/:id/dirs?path=   目录浏览（resolve 后列一层）
GET    /dsh-remote-worktree/repos              列表（每项附远端 branch / clean，离线则附 error）
POST   /dsh-remote-worktree/repos              登记（nodeId, repoPath, name?），远端校验必须是 git 仓库
GET    /dsh-remote-worktree/repos/:id          单个（含实时状态）
DELETE /dsh-remote-worktree/repos/:id          注销（仍有 worktree 归属时 409）
GET    /dsh-remote-worktree/worktrees          列表
POST   /dsh-remote-worktree/worktrees          创建（repoId, name, baseRef?；也接受 nodeId + repoPath）
DELETE /dsh-remote-worktree/worktrees/:id      删除（force / deleteBranch）
POST   /dsh-remote-worktree/worktrees/:id/bring-back
```

「机器」记录的是**怎么到达**，不是到达哪里：`transport` 现在只有 `ssh`（`target` 即 `user@host` 或 `~/.ssh/config` 别名），另有 `remotePort` 指远端 daemon 监听的 loopback 端口。连接时宿主自己找一个空闲本地端口，用 `ssh -N -L <local>:127.0.0.1:<remotePort>` 开转发，再拨 `127.0.0.1:<local>`——与 VS Code Remote-SSH 同一形状。本地端口属于运行时而不属于身份，因此每次连接现取，并随状态上报给界面。

文档版本 2 之前（版本 1）的记录只存了 `host`/`port`，读取时按 `direct` transport 原样迁移，nodeId 不变，因此已锚定的仓库与 worktree 不会失联；`direct` 变体只为这个迁移而存在，没有任何入口会创建它。

转发会失败得具体而不是笼统：未知主机密钥会告诉你先跑一次 `ssh <target>`，sshd 禁止转发会告诉你改 `AllowTcpForwarding`，密钥被拒会指向 ssh-agent。`ssh -L` 无论远端是否真有进程监听都会绑定本地端口，所以握手超时会被翻译成「转发是通的，但 <remotePort> 上没人应答」，而不是让人无限等待。

「仓库」是机器与 worktree 之间的真实一层：登记时向 daemon 要一次 `git.repoState`，证明该路径确实是 git 仓库，此后只读记录；branch 与 clean 每次列表都实时询问、不落盘，否则写下的那一刻就已经过期。删除节点会连带删除它的仓库登记，因为仓库只能经由机器到达。按路径切 worktree 时也会补登记仓库，于是无论从哪个入口切出的 worktree，UI 的树都是完整的。

这些路由自动处于 DSH 既有的 browser-trust fence 之内（loopback / `trustedHosts` + 签名 cookie），所以只要 Web 服务是本地的就安全。

### 8.2 client 半边

`dsh.client` 半边注册 `settings.section` 一个「远程 worktree」区，渲染一棵三层折叠树：机器 → 该机器上登记的仓库 → 该仓库切出的 worktree。每层都显示实时状态（连接状态、分支、是否干净），操作按钮放在展开层内，破坏性操作走确认弹窗。目录选择器复用 `/nodes/:id/dirs`，因此它列出的内容与会话真正看到的远端文件系统是同一份。

组件复用宿主的 `ui-primitives`（`Button` / `Input` / `Modal` / `DisclosureRow` / `Tag` / `StateDot` / 图标），文案全部走 `ctx.locale.register` 的中英双语字典。样式以注入式样式表交付（动态 bundle 没有 CSS 通道），类名带 `drw-` 前缀，取值一律用 `--dsw-*` 语义 token，因此自动跟随明暗主题。

## 9. 包与文件布局

```
dsh-remote-worktree/                 # 插件本体（bundle）
├── package.json                     # dsh.bundle.patch + dsh.client
├── cordis.patch.yml                 # insert 插件行 + 覆盖 fs / bash 两行
├── src/
│   ├── index.ts                     # apply()：装配 registry / routing / tools / commands / web
│   ├── nodes/registry.ts            # NodeRegistry：durable JSON + 文档版本迁移（v1 direct → v2 ssh）
│   ├── ssh/tunnel.ts                # 动态本地端口 + ssh -L 转发 + 可操作的失败诊断
│   ├── nodes/client.ts              # NodeClient：TCP/TLS + vscode-jsonrpc + 重连
│   ├── routing/fs.ts                # RoutingFileSystem
│   ├── routing/subprocess.ts        # RoutingSubprocessRuntime（含同步 spawn 代理）
│   ├── routing/bash.ts              # RoutingBashExecutor
│   ├── routing/classify.ts          # 路由键 + 二义性判定
│   ├── anchors/store.ts             # 锚点元数据 + workspace 注册钩子
│   ├── repos/store.ts               # 仓库登记（durable JSON + 跨进程锁）
│   ├── worktree/manager.ts          # 远端 git worktree 生命周期
│   ├── tools.ts                     # rw_create / rw_list / rw_status
│   ├── commands.ts                  # /rwt ...
│   └── web/{api.ts,mount.ts}        # ctx.webServer 路由（传输无关的 api + 薄适配层）
├── client/
│   ├── client.ts                    # apply()：样式安装 + locale 注册 + slot 贡献
│   ├── Section.tsx                  # 机器 / 仓库 / worktree 三层折叠树
│   ├── locales.ts                   # 中英双语字典
│   └── styles.ts                    # 注入式样式表（--dsw-* token）
└── agent/                           # 独立的 sidecar 包（另一个 npm 包，见下）
dsh-remote-worktree-agent/
├── package.json                     # bin: dsh-remote-agent
└── src/{main.ts, rpc.ts, fs.ts, subprocess.ts, git.ts, audit.ts}
```

sidecar 单独发包的理由：它依赖原生模块（`node-pty`），且安装位置在远端，不应该进入本地插件的依赖图。

## 10. 阶段划分

| 阶段 | 内容 | 可见结果 |
|---|---|---|
| **P0** | wire 契约与错误码、协议握手、`classify()` 规则 | 契约冻结 |
| **P1** | sidecar 骨架 + `node.stat`；NodeRegistry；连接/心跳/重连；Web node 增删与目录浏览 | Web 上能管理机器、浏览远端目录 |
| **P2** | RoutingFileSystem + RoutingSubprocessRuntime 指向**已有远端目录**（先不建 worktree） | `read` / `write` / `edit` / `bash` / `grep` 真的跑在远端 |
| **P3** | 锚点 + workspace 注册 + 远端 git worktree 创建/删除 + `rw_*` 工具 + `/rwt` 命令 + 会话打开 | 完整闭环 |
| **P4** | `spawnTerminal`（PTY）、spill 锚点、审计拉取、bring-back、rg 存在性诊断 | 常驻终端可用 |

P2 刻意先于 P3：先用一个普通远端目录把路由打通，再叠加 worktree。路由不工作的时候，worktree 只会让问题更难定位。

## 11. 安全模型

- **sidecar 不是沙箱**。它以安装用户身份执行任意命令；能得到 node 的 token 就等于得到那台机器上该用户的 shell。UI 必须显著提示这一点。
- **token**：只在本地与远端 600 权限文件里，不出现在配置、会话日志、模型上下文、Web 响应里（`GET /nodes` 只回 `hasToken`）。
- **监听**：默认 loopback；`0.0.0.0` 需要显式开关且强制 TLS。
- **传输**：明文 TCP 仅限 loopback / 隧道；无隧道又无 TLS 的组合直接拒绝启动。
- **审计**：`sp.spawn` 与远端写全部落 JSONL，本地可读。
- **卸载**：插件被移除时，远端 sidecar 不会自动消失——README 必须给出「怎么找到并停掉它」，这是自建 server 相对 SSH 的主要运维成本。
- **沙箱语义**：`danger-full-access` 下不调用 `ctx.sandbox`；远程世界无法被本地 bwrap/Seatbelt 约束，**机器边界与审批策略是唯一防线**。

## 12. 风险与未决问题

1. **同步 `spawn` 的代理 handle**（最高）。远端往返与同步契约天然冲突；代理必须让 `terminate` / `waitForExit` / `readFrom` 在 ready 前排队而非失败。需要一组专门的并发测试（spawn 途中 terminate、spawn 失败、ready 前读）。
2. **`processPathFromHostPath` 没有会话上下文**，无法回答「这个主机文件在哪个世界」。v1 保持本地语义（返回主机路径），于是远端会话里的图片附件会读到本地路径并失败。彻底修需要把该方法改成按会话寻址——那是**第一方接缝变更**，本插件做不了。v1 的缓解：附件走一次显式上传，把文件物化到远端后再返回远端路径。
3. **路由二义性**（§5.6）。规则简单但必须严格实现并测试，否则会出现「读 A 机器、写 B 机器」这种静默错配。
4. **cwd 变量覆写只影响模型所见**，会话里仍可能混入锚点路径，观感不一致。
5. **`sandbox-policy` 的模型可见文本**描述的是本地 root；远端会话需要额外一句「你在 node X 的 /path 上工作」，否则模型会以为自己编辑本地文件。
6. **sidecar 版本漂移**：插件升级后远端可能是旧协议。握手 fail loud + README 给出升级命令；不做向后兼容。
7. **原生模块**：`node-pty` 是原生依赖，sidecar 必须装包，无法退化成单文件 bundle（除非放弃 PTY）。
8. **两个插件撞名**：`dsh-task-worktree` 已占用 `worktree_create` 与 `/worktree`。必须用独立命名空间。

## 13. 备选方案

- **走 SSH（ssh2）**：被否（用户决定自建 server）。若未来要降低部署成本，可以并存为第二种 transport provider，代价是失去 PTY 与部分字节/进程保真度。
- **自定义 `rw_*` 工具替代路由**：被否。会在既有接缝之上复制一套平行语义，模型要学两套，且文件工具的差异/版本守卫/原子写会分叉。
- **本地镜像 + 双向同步**：被否。同步器是一个带冲突、删除与部分失败语义的新 owner；锚点只存元数据，代价是每次读写都跨网络。
- **把整个 harness 放到远端跑**：被否，那是另一个产品（远程 harness），本设计刻意让会话、日志、模型调用留在本地。
- **把远端注册成 `ctx.sandbox` provider**：被否。`ctx.sandbox` 包的是同一主机内核的 argv，容器/远程执行按设计是替换整条接缝而不是注册进来。
- **不建锚点、只用会话头徽章标记**（`dsh-task-worktree` 的做法）：可行且更少本地痕迹，但 `workspaceRegistry` 与 `SessionHeader.cwd` 的校验会让「打开成会话」变成特例；锚点把这条路径拉回既有机制。

## 14. 复用与自写清单

原则：**不继承实现类；本地分支组合现成实现，远端 daemon 自己写。** 判断标准是「这里的复用是否自然」，不是「能不能复用」。

### 14.1 本地分支：组合（零实现代码）

| 组合对象 | 挂在哪 | 白拿的语义 |
|---|---|---|
| `SandboxedFileSystem`（`dsh-fs-sandbox`） | `ctx.isolate('fs')` 子上下文 | 沙箱写入围栏、原子写、`FsVersion` 守卫、跨 chunk UTF-8 解码与二进制拒绝、realpath 目标键 |
| `LocalSubprocessRuntime`（`dsh-subprocess-local`） | `ctx.isolate('subprocess')` 子上下文 | 托管进程范围、TERM→KILL 阶梯、采集与 spill、`node-pty` 终端与前台进程组 |
| `SandboxBashExecutor`（`dsh-bash-sandbox`） | `ctx.isolate('shell')` 子上下文 | 本地 bash 的沙箱 argv、请求/规格分离、超时与输出上限 |

三者都在本地进程内，接口与路由 provider 完全相同，委托是 1:1 的一行——这不是强行复用，而是最省的写法。

### 14.2 远端 daemon：自己写

逐项清单见 §4.4。**不引入任何 `@deepseek-ai/dsh-*` 依赖，也不引入 Cordis**——远端只需要 Node ≥ 22。

### 14.3 本地插件仍可依赖的 DSH 包

这些是**接缝定义**、被组合的实现、或平台服务；当前都是 public 包（版本 `0.1.5-rc.1`），按已发布版本线声明 `peerDependencies`（`^0.1.2-rc.1` 起，与 `dsh-task-worktree` 一致），开发期精确 pin。

| 包 | 用途 |
|---|---|
| `@deepseek-ai/dsh-fs` / `dsh-subprocess` / `dsh-shell` | 接缝定义与已发布类型——**只 `import type`**，用于 `Pick` 出契约类型做编译期检查；注册走 `ctx.provide`，不继承 |
| `@deepseek-ai/dsh-fs-sandbox` / `dsh-subprocess-local` / `dsh-bash-sandbox` | 被组合的本地实现（只实例化，不继承） |
| `@deepseek-ai/dsh-tools` | 注册 `rw_*` 模型工具 |
| `@deepseek-ai/dsh-storage` + `dsh-storage-domain` | node 注册表与锚点的持久化 |
| `@deepseek-ai/dsh-credentials` | node token 的存储与引用 |
| `@deepseek-ai/dsh-workspace` | `workspaceRegistry.create` / `delete` / `resolveByPath` |
| `@deepseek-ai/dsh-host-webserver` | `ctx.webServer.register(route)` 开管理路由 |
| `@deepseek-ai/dsh-brand` | `NodeId` / `AnchorId` 品牌 id |
| `@deepseek-ai/dsh-timeout` | 连接与终止 deadline |
| `@deepseek-ai/dsh-atomic-write` | 锚点元数据、审计日志的原子写 |
| `@deepseek-ai/dsh-util-crypto` | UUID 与字节编码 |
| `@deepseek-ai/dsh-schemastery` | 插件 Config 校验（与 DSH 插件惯例一致） |
| `@deepseek-ai/cordis` | 本地插件运行时（远端 daemon 不用） |

### 14.4 公共库

| 库 | 周下载 | License | 用途 |
|---|---|---|---|
| `vscode-jsonrpc` | 12.7M | MIT | wire 协议：请求 / 通知 / 取消 / 流，架在任意 `Readable` + `Writable` 上；微软维护，零运行时依赖 |
| `node-pty` | 2.96M | MIT | 远端 PTY（本地分支经 `dsh-subprocess-local` 已带一份，不重复引） |
| `memfs` | 19.9M | MIT | **仅测试**：单测里伪造一个远端 fs，不必起进程 |
| `tsdown` / `vitest` | — | — | 构建与测试 |

**`@yarnpkg/fslib` 已从清单移除**：它原本是为「自己实现 fs」准备的挂载/代理抽象层；改为组合 `SandboxedFileSystem` 之后不再需要，少一个 CJS 依赖、少一层抽象。

### 14.5 client 半边

| 复用 | 用途 |
|---|---|
| `@deepseek-ai/dsh-client-ui-primitives` | 表单、按钮、对话框等原语——**不要引入 UI 组件库**，否则观感与产品不一致 |
| `@deepseek-ai/dsh-client-locale` | 文案走 `t()` 字典 |
| `@deepseek-ai/dsh-client-ui-workspace` | 目录流洞的 owner 类型 `DirectoryFlowOwnerProps` 与 `conversation.hero.workspace` / `sidebar.workspaces` 两个洞 |
| `ctx.slots`（`dsh-client-ui-slots`） | 注册 `settings.section` 与目录流 occupant |
| `@deepseek-ai/dsh-util-workspace-path` | 浏览器安全的路径与显示助手——锚点路径显示成远端路径正好用它 |
| `@deepseek-ai/dsh-api-remotes/client` | 若要走类型化 RPC 而不是自建 HTTP 路由 |

### 14.6 明确不用的库

| 库 | 为什么不用 |
|---|---|
| `@yarnpkg/fslib` / `unionfs` / `memfs`（生产） | 本地分支已由 `SandboxedFileSystem` 组合提供；远端分支自己写更直接，不需要挂载/代理抽象层 |
| `fs-extra` / `graceful-fs` | 只是 `node:fs` 的增强与重试包装，不解决分层与路由 |
| `simple-git` / `isomorphic-git` | 只需要 4 条 git 命令，用 `ctx.subprocess`（本地）或 `child_process`（远端）跑即可 |
| `socket.io` / `engine.io` | 没有降级传输的需求 |
| `ssh2` | 本设计不走 SSH；将来若加 SSH transport 再引 |
| 任意 UI 组件库 | 必须用 `dsh-client-ui-primitives` 才与产品观感一致 |
