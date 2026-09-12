# dsh-remote-ssh-worktree

一个 DSH 插件：把远端机器上的一个目录放到 Harness 面前——read、write、edit、bash、grep 和终端工具都在那里执行，
可以是 git worktree，也可以是目录本身——而模型看到的是普通的本地路径。

[English](README.md) | 中文

![在远端 worktree 里执行工具的会话](docs/screenshots/zh/08-session.png)

| 机器列表 | 已连接 | 切出的 worktree |
| --- | --- | --- |
| ![机器列表](docs/screenshots/zh/01-section.png) | ![已连接的机器与仓库](docs/screenshots/zh/03-connected.png) | ![已创建的 worktree](docs/screenshots/zh/06-worktree-created.png) |

## 能做什么

- 通过 SSH 连接机器——`user@host` 或 `~/.ssh/config` 里的别名，机器上不需要手动装任何东西。
- 从机器上任意仓库切出 `worktree/<名称>`，把该 checkout 注册成 DSH 工作区。
- 还不是 git 仓库的目录也能当工作区打开；之后在机器上 `git init`，不用重新登记就能从它切 worktree。
- read、write、edit、bash、grep 和终端工具都在那台机器上原样执行。
- 删 worktree 不会弄丢活儿：checkout 消失，分支默认保留，除非你明确要求连分支一起删。

## 安装

需要 Node 22.19+（或 24+）和 `ssh`。agent 走 Release 下载，所以使用插件不需要 Rust 工具链。

```sh
git clone https://github.com/lengmoXXL/dsh-remote-ssh-worktree
cd dsh-remote-ssh-worktree && npm install && npm run build
dsh plugin --profile web add "$PWD"
dsh --profile web
```

## 怎么用

**设置 → 远程 worktree。** 填机器的 SSH 目标和 token（任意字符串，它是 daemon 的共享密钥）。插件加载时会自己
连接，每台机器重试几次；一直连不上的会留成失败状态，旁边有「连接」按钮可以手动再试。

仓库就是机器上的任意目录。每一行可以打开、关闭或移除它所持有的东西；还不是 git 仓库的目录也可以先当工作区打开。

**在会话里**，人敲 `/rwt`，模型调用同一批操作的工具：

| | |
| --- | --- |
| `/rwt list` · `/rwt nodes` | 有哪些 worktree，以及每台机器的状态 |
| `/rwt create <nodeId> <repoPath> <name> [baseRef]` | 切一个 worktree |
| `/rwt remove <anchorId> [--force] [--delete-branch]` | 删掉 checkout；分支默认保留 |
| `rw_list` · `rw_create` · `rw_remove` | 同样三件事的模型工具 |

## 怎么实现的

- 插件把 Harness 的 `fs`、`subprocess`、`shell` 三个 seam 换成路由版本：属于远端锚点的路径交给那台机器的
  agent，其余路径仍在本地。
- agent 是一个静态链接的 Rust 二进制。它监听内核分配的随机 loopback 端口并写进状态文件，所以配置一台机器
  只需要 SSH 目标和 token，不需要约定端口。
- 插件负责安装和更新它：连接时读 `uname`，从本仓库的 GitHub Releases 下载对应构建，用 `SHA256SUMS` 校验，
  经同一条 SSH 连接上传、脱离会话启动，再转发到它发布的端口。
- agent 流量经由 `ssh -L` 到达本机，因此连接的可信度等同于你自己的 SSH 访问。

## 架构

```text
┌─ 浏览器 ───────────────────────────────────────────────────┐
│  plugin/client    设置面板                                 │
└──────────────────────────────┬─────────────────────────────┘
                               │ 管理 API（HTTP）
┌─ plugin/   DSH 表面 ─────────▼─────────────────────────────┐
│  api · tools · commands        经 models                   │
│  routing/  fs · subprocess · shell 三个 seam → SDK         │
└──────────────────────────────┬─────────────────────────────┘
                               │
┌─ models/   业务语义 ─────────▼─────────────────────────────┐
│  worktrees · machines · autoconnect                        │
│  routing   路径属于哪个执行世界                            │
└─────────────┬───────────────────────────────┬──────────────┘
              │ 状态                          │ SDK
┌─ storage/ ───────────────┐  ┌─ remote/   SDK ──────────────┐
│  持久状态                │  │  channel · protocol          │
│  anchors · nodes · repos │  │  ssh · agent 安装            │
│  document：锁 + 原子替换 │  │  每台机器一条连接            │
└──────────────────────────┘  └───────────────┬──────────────┘
                                              │ ssh -L，JSON-RPC 2.0
                              ┌─ 机器（可多台） ─────────────┐
                              │  dsh-remote-agent（Rust）    │
                              │  随机 loopback 端口          │
                              └──────────────────────────────┘
```

`remote/` 把机器上的 daemon 变成 SDK，`storage/` 保存跨重启的状态，`models/` 是建在两者之上的业务语义，`plugin/`
是唯一知道 DSH 的一层。依赖只向下，`src/index.ts` 是唯一把它们组装起来的文件。设置面板是另一半：它跑在浏览器里，
经管理 API 访问宿主机。

## 状态在哪

`$DSH_HOME/remote-worktrees/` 下有 `nodes.json`、`repos.json`、每个远端目录对应的锚点目录，以及按平台下载的
agent 构建。卸载插件不会删掉这个目录；删掉它等于忘掉所有机器。

## 许可证

MIT
