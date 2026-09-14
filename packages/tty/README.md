# dsh-tty

English | [中文](README.zh.md)

The terminal seam for DeepSeek Harness: a plugin asks `ctx.tty` for a PTY and
gets a handle it can write to, resize, and release.

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

A consumer names a working directory and never asks which machine owns it. The
provider composed for that directory answers, exactly as `ctx.fs` and
`ctx.subprocess` do:

- [dsh-tty-local](../tty-local) owns a PTY on this host.
- dsh-tty-remote proxies a PTY a node daemon holds; the remote workspace plugin
  composes it for the directories its nodes own.

## Why this exists beside `ctx.subprocess`

The subprocess seam already allocates terminals. It has no `resize`: its handle
stops at allocation, text, foreground groups, and teardown. A terminal on screen
is a view a person changes the shape of while the shell inside it keeps running,
so the verb this seam adds is the one the other seam cannot carry.

The seam carries no foreground verbs. Its consumer is a terminal on screen,
whose Ctrl-C travels as input bytes the line discipline turns into a signal; the
model-facing PTY tools keep using the seams that already carry them. A verb
earns a place here with a caller.

## Providers

| Package | Provides |
| --- | --- |
| `dsh-tty-local` | `ctx.tty` over node-pty, for this host |
| dsh-tty-remote | terminal handles over the node daemon's `term.*` methods |
| dsh-remote-workspace | `ctx.tty` routing each directory to the machine that owns it |

A provider extends `TtyRuntime`, which is what publishes it as `ctx.tty`; a
routing provider that is not a subclass is registered with `ctx.provide`.
