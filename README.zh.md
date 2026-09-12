# dsh-remote-ssh-worktree

一个 DSH 插件：在远端机器的 git worktree 里运行 Harness 的文件、Shell 和终端工具。

[English](README.md) | 中文

![在远端 worktree 的会话里执行工具](docs/screenshots/zh/08-session.png)

| 机器列表 | 已连接 | 切出的 worktree |
| --- | --- | --- |
| ![机器列表](docs/screenshots/zh/01-section.png) | ![已连接的机器与仓库](docs/screenshots/zh/03-connected.png) | ![已创建的 worktree](docs/screenshots/zh/06-worktree-created.png) |

## 能做什么

- 通过 SSH 连接机器——`user@host` 或 `~/.ssh/config` 里的别名，机器上不需要手动装任何东西。
- 从机器上任意 git 仓库切出 `worktree/<名称>`，把该 checkout 注册成 DSH 工作区；同一行上可以打开、关闭或删除它。
- 还不是 git 仓库的目录也能登记，并直接作为工作区打开；在机器上 `git init` 之后不用重新登记就能切 worktree。
- 之后 read、write、edit、bash、grep 和终端工具都在那台机器上原样执行，模型看不出文件在远端。
- 删除时只删 checkout，分支保留，未合并的提交不会悄悄丢失。

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
是唯一知道 DSH 的一层。依赖只向下，`src/index.ts` 是唯一把它们组装起来的文件，`ids.ts` 是各层共用的身份词汇。
设置面板是另一半：它跑在浏览器里，经管理 API 访问宿主机。

## 安装

```sh
git clone https://github.com/lengmoXXL/dsh-remote-ssh-worktree
cd dsh-remote-ssh-worktree && npm install && npm run build
dsh plugin --profile web add "$PWD"
dsh --profile web
```

## 许可证

MIT
