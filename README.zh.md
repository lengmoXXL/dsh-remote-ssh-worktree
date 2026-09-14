# dsh-remote-workspace

[English](README.md) | 中文

在别的机器上干活的 DeepSeek Harness 插件，以及它们共用的 PTY 接缝。所有包一起
开发、一起测试，每个包也都能单独挂载。

| 包 | 是什么 |
| --- | --- |
| [`remote-workspace`](packages/remote-workspace) | 设置面板：通过 SSH 接入的机器、机器上的仓库、从仓库切出的 worktree。把 `fs`、`subprocess`、`shell`、`tty` 四个 seam 换成路由版本。 |
| [`terminal`](packages/terminal) | Web GUI 右侧边栏里的终端，每个会话一个 xterm.js 标签页，开在该会话的工作区——不管那台工作区属于哪台机器。 |
| [`tty`](packages/tty) | 终端接缝（`ctx.tty`）：分配 PTY、写入、改尺寸、释放。 |
| [`tty-local`](packages/tty-local) | 本机持有的 PTY，基于 node-pty。 |
| [`tty-remote`](packages/tty-remote) | 节点守护进程持有的 PTY，走 Harness wire。 |

远端工作区在每台机器上安装的 Rust agent 在
[`agent/`](agent)，从本仓库以各平台 `.tar.gz` 加 `SHA256SUMS` 的形式发布。

## 目录

```
packages/           每个插件、每条接缝一个 npm workspace
agent/              节点守护进程（Rust），在这里构建与发布
tsconfig.base.json  所有包共同继承的编译选项
```

## 开发

```sh
npm install                 # 一次装好所有 workspace
npm run build:agent         # e2e 用例要驱动这个二进制
npm run typecheck           # 所有包
npm test                    # 先构建，再跑每个包的测试
npm run test:browser        # 用真实 Firefox 跑设置面板
npm run test:agent          # Rust agent 自己的测试
```

## 挂载

部署时把插件 `link:` 进 profile，再在 bundle 或 patch 层里点名；库包（`tty`、
`tty-local`、`tty-remote`）作为使用它们的插件的依赖被解析，不需要自己出现在
profile 里。

```json
{
  "dependencies": {
    "dsh-remote-workspace": "link:/path/to/this/repository/packages/remote-workspace",
    "dsh-terminal": "link:/path/to/this/repository/packages/terminal"
  }
}
```
