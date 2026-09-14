# dsh-tty-remote

English | [中文](README.zh.md)

The remote half of the terminal seam for DeepSeek Harness: a PTY a node daemon
owns, exposed as an ordinary [`dsh-tty`](../tty) handle.

The wire serves retained windows and answers one request at a time, so a
terminal on another machine cannot be streamed. This package polls the daemon's
window into a local `Readable`, which is why a consumer reads the same stream it
would read from a local PTY, one poll interval behind.

```ts
import { createRemoteTty } from 'dsh-tty-remote'
import type { TtyWire } from 'dsh-tty-remote'

const wire: TtyWire = {
  spawn: request => channel.request('term.spawn', request),
  read: (termId, fromByte) => channel.request('term.read', { termId, fromByte }),
  // …write, resize, terminate, outcome
}

const terminal = await createRemoteTty(wire, {
  argv: ['/bin/sh', '-l'],
  cwd: '/srv/checkout',
  cols: 80,
  rows: 24,
})
```

`TtyWire` is a port, not the harness protocol: it names the six methods this
provider needs, and whoever owns a node's wire adapts its channel to it. The
plugin that does so is checked against both the port and its own protocol table
in one place, so a wire that drifts fails to compile instead of failing at a
terminal.

A terminal settles once, with the facts it has: one that exited, one that was
released, and one whose transport dropped all end the same way. A handle whose
allocation itself failed is the one failure the caller sees thrown.
