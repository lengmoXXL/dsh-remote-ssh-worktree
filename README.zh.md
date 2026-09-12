# dsh-remote-ssh-worktree

一个 DSH 插件：在远端机器的 git worktree 里运行 Harness 的文件、Shell 和终端工具。

[English](README.md) | 中文

![已连接的机器、它的仓库，以及切出的 worktree](docs/screenshots/zh/06-worktree-created.png)

| 机器列表 | 已连接 |
| --- | --- |
| ![机器列表](docs/screenshots/zh/01-section.png) | ![已连接的机器与仓库](docs/screenshots/zh/03-connected.png) |

## 能做什么

- 通过 SSH 连接机器——`user@host` 或 `~/.ssh/config` 里的别名，机器上不需要手动装任何东西。
- 从机器上任意 git 仓库切出 `worktree/<名称>`，并把该 checkout 注册成 DSH 工作区。
- 之后 read、write、edit、bash、grep 和终端工具都在那台机器上原样执行，模型看不出文件在远端。
- 把 worktree 的分支合并回仓库分支；有冲突会中止合并，不会把仓库留在合并中间状态。

## 怎么实现的

- 插件把 Harness 的 `fs`、`subprocess`、`shell` 三个 seam 换成路由版本：属于远端锚点的路径交给那台机器的
  agent，其余路径仍在本地。
- agent 是一个静态链接的 Rust 二进制。它监听内核分配的随机 loopback 端口并写进状态文件，所以配置一台机器
  只需要 SSH 目标和 token，不需要约定端口。
- 插件负责安装和更新它：连接时读 `uname`，从本仓库的 GitHub Releases 下载对应构建，用 `SHA256SUMS` 校验，
  经同一条 SSH 连接上传、脱离会话启动，再转发到它发布的端口。
- agent 流量经由 `ssh -L` 到达本机，因此连接的可信度等同于你自己的 SSH 访问。

## 安装

```sh
git clone https://github.com/lengmoXXL/dsh-remote-ssh-worktree
cd dsh-remote-ssh-worktree && npm install && npm run build
dsh plugin --profile web add "$PWD"
dsh --profile web
```

## 许可证

MIT
