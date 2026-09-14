# dsh-tty-local

[English](README.md) | 中文

DeepSeek Harness 的本机终端提供者：在本机持有 PTY，发布为 `ctx.tty`。

没有路由者替某个目录作答时，把它挂上即可：

```yaml
- insert:
    - id: dsh-tty-local
      name: dsh-tty-local
```

运行 [dsh-remote-workspace](../remote-workspace) 的部署不用把它作为一行挂载：那个插件
会在隔离作用域里组合本包的提供者，负责节点不拥有的目录，于是本机终端照常工作，远端
终端被路由出去。

## 它做什么

- 通过 [node-pty](https://github.com/microsoft/node-pty) 分配，`TERM=xterm-256color`，
  调用方环境叠加在本进程环境之上。
- 输出以字节形式发布在 `Readable` 上，随终端结束而结束。
- 把 `resize(cols, rows)` 变成 PTY 自己的窗口尺寸——全屏程序据此重绘，而不是按旧宽度
  继续画。内核负责给前台进程组发信号，这里不手动发。
- 释放终端时先 `SIGTERM`，超过调用方给的宽限期再 `SIGKILL`，两种情况都用退出事实结束
  `done`。

它没有配置：运行什么、在哪、多大、等多久，全部随请求到达。
