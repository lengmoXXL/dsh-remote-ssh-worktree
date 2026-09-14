# dsh-tty-local

English | [中文](README.zh.md)

Terminal provider for this host, built on node-pty. Mount it in a deployment that has no router:

```yaml
- insert:
    - id: dsh-tty-local
      name: dsh-tty-local
```

A deployment running [remote-workspace](../remote-workspace) does not mount it: that plugin provides the local
terminals itself.

- Runs the caller's program with this host's environment plus `TERM=xterm-256color`.
- Resizes a running terminal to the size the caller asks for, so full-screen programs redraw.
- Releasing a terminal signals it, then kills it after `graceMs`.
- No configuration.

MIT
