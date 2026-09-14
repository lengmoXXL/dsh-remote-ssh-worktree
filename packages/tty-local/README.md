# dsh-tty-local

English | [中文](README.zh.md)

The local terminal provider for DeepSeek Harness: a PTY this host owns,
published as `ctx.tty`.

Mount it where no router answers for the directory a terminal asks for:

```yaml
- insert:
    - id: dsh-tty-local
      name: dsh-tty-local
```

A deployment that runs [dsh-remote-workspace](../remote-workspace) does not mount
it as a row: that plugin composes this package's provider in an isolated scope
for the directories its nodes do not own, so local terminals keep working while
remote ones route away.

## What it does

- Allocates through [node-pty](https://github.com/microsoft/node-pty), with
  `TERM=xterm-256color`, the caller's environment layered onto this process's
  own.
- Publishes output as bytes on a `Readable` that ends with the terminal.
- Turns `resize(cols, rows)` into the PTY's own window size, which is what makes
  a full-screen program redraw instead of drawing against the old width. The
  kernel signals the foreground process group; nothing here sends it by hand.
- Releases a terminal with `SIGTERM`, then `SIGKILL` after the caller's grace
  period, and settles `done` with the exit facts either way.

It takes no config: what to run, where, how large, and how long to wait all
arrive on the request.
