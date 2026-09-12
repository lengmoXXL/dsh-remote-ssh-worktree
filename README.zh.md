# dsh-remote-ssh-worktree

在远端机器的 git worktree 里运行 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的工具。

[English](README.md) | 中文

![远程 worktree 面板](docs/screenshots/zh/06-worktree-created.png)

## 这是什么

一个 DSH 插件。它把 Harness 的文件、子进程、Shell 三个 seam 换成路由版本：属于远端锚点的路径由那台机器上的
agent 通过连接提供服务，其余路径仍然在本地。机器上切出的 worktree 会注册成一个普通的 DSH 工作区，因此原生的
read / write / edit / bash / grep 和终端工具都能直接对它工作，模型完全看不出文件不在本地。

- 机器上的 agent 就是**一个静态链接的 Rust 二进制**。除了 SSH 访问权限和 `git`，那台机器不需要预先装任何东西。
- 插件自己负责安装和更新它：连接时先读机器的 `uname`，从本仓库的 GitHub Releases 取对应构建，用
  `SHA256SUMS` 校验，通过同一条 SSH 连接上传并启动，然后转发到它发布的端口。
- agent 监听内核分配的随机 loopback 端口并把端口写进状态文件，所以配置一台机器只需要 SSH 目标和 token，
  不需要双方约定端口。

## 环境要求

- 带 Web profile 的 DSH：管理界面是一个设置分区。
- 一台 Linux 或 macOS、x86_64 或 aarch64 的机器，能用密钥 SSH 登录（不会交互提示密码），并已安装 `git`。
- 运行 DSH 的那台机器能访问 `api.github.com`（每个 agent 版本首次下载时需要）。之后二进制会缓存在本地。

## 安装

包还没有发布到 npm，所以从 checkout 安装：

```sh
git clone https://github.com/lengmoXXL/dsh-remote-ssh-worktree
cd dsh-remote-ssh-worktree
npm install
npm run build
dsh plugin --profile web add "$PWD"
```

`dsh plugin` 会在 profile 目录里转调 pnpm，并把该 bundle 追加到 `dsh.profile.bundles`。如果 profile 还不存在，
第一次使用会自动初始化（包含 `@deepseek-ai/dsh-base` 和 Web app）。然后启动：

```sh
dsh --profile web
```

包发布到 npm 之后，同样的安装就是 `dsh plugin --profile web add dsh-remote-ssh-worktree`；卸载则是
`dsh plugin --profile web remove dsh-remote-ssh-worktree`。

## 使用

1. **添加机器。** 设置 → 远程 worktree → 添加机器。填 SSH 目标（`user@host`，或 `~/.ssh/config` 里的别名），
   可选 SSH 端口和私钥文件，以及一个访问令牌——任意自定的密钥即可。插件会把它写到机器上，双方用它认证。
2. **连接。** 第一次连接会在机器上安装 `~/.dsh/remote-agent/dsh-remote-agent`、脱离会话启动，并转发到它发布的
   端口。之后的连接直接复用；插件里带了更新的 agent 版本时，下次连接会自动替换。
3. **添加仓库。** 填机器上已经是 git 仓库的绝对路径；插件会先用 `git` 验证再记录。
4. **新建 worktree。** 从仓库当前 HEAD 切出 `worktree/<名称>`，并把该 checkout 注册成 DSH 工作区。打开这个
   工作区后，文件、Shell 和终端工具都在那台机器上执行。
5. **合并回来。** 把 worktree 的分支合并进仓库当前分支；冲突时会中止合并，不会把仓库留在合并中间状态。

| 机器列表 | 已连接 | 切出的 worktree |
| --- | --- | --- |
| ![机器列表](docs/screenshots/zh/01-section.png) | ![已连接的机器与仓库](docs/screenshots/zh/03-connected.png) | ![已创建的 worktree](docs/screenshots/zh/06-worktree-created.png) |

## 哪些东西跑在哪里

- 机器上：`~/.dsh/remote-agent/dsh-remote-agent`（二进制）、`token`（权限 600）、`state.json`（发布的端口与
  构建信息）、`agent.log`。
- agent 只监听 `127.0.0.1`，流量经由插件在本机打开的 `ssh -L` 转发到达，因此连接的可信度等同于你自己的 SSH
  访问，不会有任何公开监听。
- agent 以远端用户的身份提供文件系统、git、子进程和 PTY。它的 token 应当按"那台机器的 shell 权限"来对待。

## 开发

```sh
npm install
npm run typecheck      # TypeScript，host 与浏览器两半
npm run build
npm test               # 单元与 e2e；e2e 跑的是编译后的 agent
npm run build:agent    # cargo build --release -p dsh-remote-agent
cargo test --all       # agent 自身的测试
npm run test:browser   # Firefox 129+，会起一套一次性部署
```

`npm test` 需要 agent 二进制：`npm run build:agent` 会生成，或用 `DSH_REMOTE_AGENT_BIN` 指向已有的一个。浏览器
测试会把截图写到 `.artifacts/browser`；设置 `RWT_ACCEPT_LANGUAGES` 可以用另一种语言渲染界面。

## 发布一次 agent 更新

1. 同时提升 `agent/Cargo.toml` 里的 `version` 和 `src/agent/version.ts` 里的 `AGENT_VERSION` —— 有测试保证两者一致。
2. 提交后打 tag `v<版本号>` 并推送。`.github/workflows/release.yml` 会拒绝与清单不一致的 tag，构建四个平台的
   静态二进制，并连同 `SHA256SUMS` 一起发布。
3. 每台机器会在下次连接时升级；已经缓存过的宿主会复用本地下载。

## 许可证

MIT
