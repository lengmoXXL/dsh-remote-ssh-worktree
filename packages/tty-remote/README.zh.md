# dsh-tty-remote

[English](README.md) | 中文

DeepSeek Harness 终端接缝的远端一半：节点守护进程持有的 PTY，以普通的
[`dsh-tty`](../tty) 句柄暴露出来。

线上传的是保留窗口、一次请求一次应答，所以另一台机器上的终端无法被流式推送。
本包把守护进程的窗口轮询进本地 `Readable`——调用方读到的就是本地 PTY 会给出的
那条流，只落后一个轮询间隔。

```ts
import { createRemoteTty } from 'dsh-tty-remote'
import type { TtyWire } from 'dsh-tty-remote'

const wire: TtyWire = {
  spawn: request => channel.request('term.spawn', request),
  read: (termId, fromByte) => channel.request('term.read', { termId, fromByte }),
  // …write、resize、terminate、outcome
}

const terminal = await createRemoteTty(wire, {
  argv: ['/bin/sh', '-l'],
  cwd: '/srv/checkout',
  cols: 80,
  rows: 24,
})
```

`TtyWire` 是端口而不是 Harness 协议：它只列出本 provider 需要的六个方法，谁持有
节点的 wire 谁就把自己的 channel 适配上去。做这件事的插件会在同一处同时对照端口
和它自己的协议表，于是 wire 漂移会编译失败，而不是在某个终端上才失败。

一个终端只会结算一次，用的是它手里的事实：正常退出、被释放、传输掉线，三者都
以同样方式结束。调用方能看到的唯一抛错，是分配本身失败。
