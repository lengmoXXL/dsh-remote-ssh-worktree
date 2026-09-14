# dsh-remote-workspace

在远端机器上工作的 DSH 插件：管它的仓库和 worktree，并在那台机器上开终端。

[English](README.md) | 中文

| 包 | 你得到什么 |
| --- | --- |
| [`remote-workspace`](packages/remote-workspace) | **远程工作区**设置面板：通过 SSH 添加机器、登记机器上的仓库、创建或纳入 worktree，并在其中运行 Harness 的工具。 |
| [`terminal`](packages/terminal) | 右侧边栏的终端标签页，开在当前会话的工作区——本机或节点上。 |
| [`tty`](packages/tty) · [`tty-local`](packages/tty-local) · [`tty-remote`](packages/tty-remote) | 终端接缝及其两个 provider。只有自行挂载 provider 的部署才需要它们。 |

## 加入到部署

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-remote-workspace": "link:/path/to/repo/packages/remote-workspace",
    "dsh-terminal": "link:/path/to/repo/packages/terminal"
  }
}
```

再在 profile 的 `bundles` 或 `cordis.patch.yml` 里点名相应插件，然后重启服务。

MIT
