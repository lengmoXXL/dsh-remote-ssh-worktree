# dsh-remote-workspace

在另一台机器上工作：管它的仓库和 worktree，在其中运行文件、shell 和终端工具，并在 Web GUI 右侧边栏开终端。
模型看到的是普通本地路径——插件把每个路径路由到拥有它的机器。

[English](README.md) | 中文

![在远端 worktree 里执行工具的会话](docs/screenshots/zh/08-session.png)

| 机器列表 | 已连接 | 切出的 worktree |
| --- | --- | --- |
| ![机器列表](docs/screenshots/zh/01-section.png) | ![已连接的机器与仓库](docs/screenshots/zh/03-connected.png) | ![已创建的 worktree](docs/screenshots/zh/06-worktree-created.png) |

## 环境要求

- Node 22.19+ 或 24+，以及按平时方式配好的 `ssh`。
- DSH `0.1.5-rc.2`——已在可丢弃的 profile 中验证，其他版本未测试。
- 机器上不需要安装任何东西：agent 由插件从本仓库 Releases 下载并保持更新，并经 `ssh -L` 到达，因此连接的可信度
  等同于你自己的 SSH 访问。

## 安装

```sh
dsh plugin --profile web add https://github.com/lengmoXXL/dsh-remote-workspace/releases/download/plugin-v0.1.1/dsh-remote-workspace-0.1.1.tgz
```

tarball 里带着构建好的 `lib/`，安装的机器不需要编译任何东西。改插件本身时，改为从检出安装：`git clone`、
`npm install && npm run build`，再 `dsh plugin --profile web add "$PWD"`。

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

## 能做什么

- 通过 SSH 添加机器（`user@host` 或 `~/.ssh/config` 别名），或直接用内置的 `Local` 机器操作本机。
- 把机器上的任意目录登记为仓库；不要求是 git 仓库。
- 从仓库切出 worktree 并打开为工作区；检出路径会预先填好，也可以改。
- 纳入机器上已存在的 worktree；之后关闭只解除登记，不删除任何东西。
- 把普通目录直接开成工作区；之后在机器上 `git init`，可以继续在其中工作。
- read、write、edit、bash、grep 和终端工具都跑在该工作区所属的机器上。
- 在右侧边栏开终端标签页：在会话的工作区里启动该机器自己的登录 shell；隐藏标签页、切换会话、收起边栏都不会中断
  它，它跟随面板尺寸变化，也不受会话沙箱模式约束——它是你自己的 shell，不是 agent 的。
- 让 agent 在**会话里开着的**终端里干活：它会列出这些终端（每个标签就是一个终端、有自己的 id）、读它们的输出、
  输入文本和按键（包括 `ctrl+c`）、等待某段输出出现。标签关掉它就不再碰那个终端；它做的每一步你都实时看得到。

## 使用

**设置 → 远程工作区。** 用 SSH 目标和 token 添加机器——token 是 daemon 的共享密钥，任意字符串；`Local` 恒在首位，
不需要这两项。机器会自动连接，一直连不上的显示**连接**按钮。登记仓库后，用每行的菜单打开、关闭或移除它持有的
东西；在这里打开的工作区会出现在会话里，其工具和终端都跑在拥有它的机器上。

**终端。** 右侧边栏的添加控件里有一个**终端**按钮；每个会话一个标签页，开在该会话的工作区里。可以开多个：每个
标签是一个独立终端、有自己的 id，你和 agent 都能分得清。关闭标签页即结束那个 shell。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `worktreeRoot` | `~/.dsh/worktrees` | 每台机器上切出的检出所在的根目录。 |
| `shell` | 未设置 | 侧边栏终端运行的程序；未设置则用机器自己的登录 shell。 |
| `shellArgs` | `['-l']` | `shell` 之后的参数；`shell` 未设置时忽略。 |
| `graceMs` | `3000` | 关闭终端时留给它退出的时间（毫秒）。 |

MIT
