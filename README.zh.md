# dsh-remote-workspace

在另一台机器上工作：管它的仓库和 worktree、在其中运行文件/shell/终端工具，并在 Web GUI 右侧边栏开终端。
模型看到的是普通本地路径——插件把每个路径路由到拥有它的机器。

[English](README.md) | 中文

![在远端 worktree 里执行工具的会话](docs/screenshots/zh/08-session.png)

| 机器列表 | 已连接 | 切出的 worktree |
| --- | --- | --- |
| ![机器列表](docs/screenshots/zh/01-section.png) | ![已连接的机器与仓库](docs/screenshots/zh/03-connected.png) | ![已创建的 worktree](docs/screenshots/zh/06-worktree-created.png) |

## 环境要求

- Node 22.19+ 或 24+，以及按平时方式配好的 `ssh`。
- DSH `0.1.5-rc.2`，已在可丢弃的 profile 中验证；其他版本未测试。
- 机器上不需要安装任何东西：agent 由插件下载并保持更新。

## 安装

```sh
dsh plugin --profile web add https://github.com/lengmoXXL/dsh-remote-workspace/releases/download/plugin-v0.1.0/dsh-remote-workspace-0.1.0.tgz
```

tarball 里带着构建好的 `lib/`，安装的机器不需要编译任何东西。

本插件要接管 base profile 提供的服务，而 host plane 每项服务只允许一个实现，因此它自己的 patch 层不能停用这些行：
把这四行也加进 `$DSH_HOME/profiles/web/cordis.patch.yml`。缺了它们插件仍会加载，并在 stderr 上说明路由未生效。

```yaml
- id: subprocess
  disabled: true
- id: fs-sandbox
  disabled: true
- id: bash-sandbox
  disabled: true
- id: pwsh-sandbox
  disabled: true
```

再用 `dsh --profile web` 启动。

改插件本身、或从检出安装：

```sh
git clone https://github.com/lengmoXXL/dsh-remote-workspace
cd dsh-remote-workspace && npm install && npm run build
dsh plugin --profile web add "$PWD"
```

`dsh plugin --profile web add github:lengmoXXL/dsh-remote-workspace` 也能用——插件靠 `prepare` 脚本自建——但 pnpm
默认拦这个脚本，要对确切 commit 放行一次；所以上面那条 release tarball 是更短的路径。

## 能做什么

- 通过 SSH 添加机器（`user@host` 或 `~/.ssh/config` 别名），或直接用内置的 `Local` 机器操作本机。
- 把机器上的任意目录登记为仓库；不要求是 git 仓库。
- 从仓库切出 worktree 并打开为工作区；检出路径会预先填好，也可以改。
- 纳入机器上已存在的 worktree；之后关闭只解除登记，不删除任何东西。
- 把普通目录直接开成工作区；之后在机器上 `git init`，就能从它切 worktree。
- read、write、edit、bash、grep 和终端工具都跑在该工作区所属的机器上。
- 在右侧边栏开终端标签页：它在会话的工作区里启动该机器自己的登录 shell，隐藏标签页、切换会话、收起边栏都不会
  中断它，并跟随面板尺寸变化；它不受会话沙箱模式约束——它是你自己的 shell。
- 用完的 worktree 可以删除，可选择是否连分支一起删。

## 使用

**设置 → 远程工作区。**

1. 添加机器：SSH 目标 + token。token 是 daemon 的共享密钥，任意字符串。机器会自动连接；
   一直连不上的会显示**连接**按钮。
2. `Local` 恒在首位，不需要目标和 token。
3. 登记仓库，然后用每行的菜单打开、关闭或移除它所持有的东西。
4. 在这里打开的工作区会出现在会话里，其工具和终端都跑在拥有它的机器上。

**终端。** 右侧边栏的添加控件里有一个**终端**按钮；每个会话一个标签页，开在该会话的工作区——本机，或拥有该
工作区的机器上。关闭标签页即结束 shell，浏览器标签页关掉不会留下 shell。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `shell` | 未设置 | 侧边栏终端运行的程序。未设置则用机器自己的登录 shell。 |
| `shellArgs` | `['-l']` | `shell` 之后的参数；`shell` 未设置时忽略。 |
| `graceMs` | `3000` | 关闭终端时留给它退出的时间（毫秒）。 |

## 说明

- 检出切在机器的检出根目录下，默认 `~/.dsh/worktrees/<仓库>/<名称>`；配置 `worktreeRoot` 可以改根目录。
- agent 从本仓库 Releases 下载、用 `SHA256SUMS` 校验，并经 `ssh -L` 到达本机，因此连接的可信度等同于你自己的
  SSH 访问。

MIT
