# dsh-remote-workspace

在远端机器上工作的 DSH 插件：管它的仓库和 worktree，并在那台机器上开终端。

[English](README.md) | 中文

| 包 | 你得到什么 |
| --- | --- |
| [`remote-workspace`](packages/remote-workspace) | **远程工作区**设置面板：通过 SSH 添加机器、登记机器上的仓库、创建或纳入 worktree，并在其中运行 Harness 的工具。 |
| [`terminal`](packages/terminal) | 右侧边栏的终端标签页，开在当前会话的工作区——本机或节点上。 |
| [`tty`](packages/tty) · [`tty-local`](packages/tty-local) | 终端接缝和本机 provider；远端那份随 `remote-workspace` 一起。 |

## 安装

```sh
git clone https://github.com/lengmoXXL/dsh-remote-workspace
cd dsh-remote-workspace && npm install && npm run build
dsh plugin --profile web add "$PWD/packages/remote-workspace" "$PWD/packages/terminal"
```

`remote-workspace` 要接管 base profile 提供的服务，而 host plane 每项服务只允许一个实现，因此它自己的 patch 层
不能停用这些行：启动前把这四行加进 `$DSH_HOME/profiles/web/cordis.patch.yml`。缺了它们插件仍会加载，并报告自己的
路由未生效。

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

重启服务即可加载。

MIT
