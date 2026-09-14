# dsh-tty

[English](README.md) | 中文

DeepSeek Harness 的终端接缝：插件向 `ctx.tty` 申请一个 PTY，拿到一个可以写入、
改变尺寸、释放的句柄。

```ts
import type { TtyHandle } from 'dsh-tty'

const terminal: TtyHandle = await ctx.tty.spawn({
  argv: ['/bin/sh', '-l'],
  cwd: '/somewhere/to/work',
  cols: 80,
  rows: 24,
})
terminal.write('ls\n')
await terminal.resize(120, 40)
await terminal.terminate()
```

调用方只给出工作目录，不需要知道它属于哪台机器：为这个目录组合出来的提供者来回答，
和 `ctx.fs`、`ctx.subprocess` 的规矩一致。

- [dsh-tty-local](../tty-local)：在本机持有 PTY。
- dsh-tty-remote：代理节点守护进程持有的 PTY；远端工作区插件为节点拥有的目录组合它。

## 为什么它和 `ctx.subprocess` 并存

subprocess 接缝本来就能分配终端，但它没有 `resize`：句柄止于分配、文本、前台进程组
和销毁。而屏幕上的终端是"人在 shell 继续运行时改变它的形状"的东西——这个接缝加的
正是另一个接缝承载不了的那个动词。

本接缝不带前台进程组相关动词。它的消费者是屏幕上的终端，Ctrl-C 作为输入字节走行规
则变成信号；面向模型的 PTY 工具继续使用本来就有这些动词的接缝。动词要靠调用方赢得
它的位置。

## 提供者

| 包 | 提供什么 |
| --- | --- |
| `dsh-tty-local` | 基于 node-pty 的本机 `ctx.tty` |
| dsh-tty-remote | 走节点守护进程 `term.*` 的终端句柄 |
| dsh-remote-workspace | 按目录路由到所属机器的 `ctx.tty` |

提供者继承 `TtyRuntime` 即被发布为 `ctx.tty`；不是子类的路由提供者用 `ctx.provide`
注册，与本仓库其它路由接缝相同。
