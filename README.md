# dsh-remote-workspace

English | [中文](README.zh.md)

DeepSeek Harness plugins for working on other machines, and the PTY seam they
share. Every package is developed and tested together, and each one is mountable
on its own.

| Package | What it is |
| --- | --- |
| [`remote-workspace`](packages/remote-workspace) | The settings section: machines over SSH, their repositories, and the worktrees cut from them. Replaces the `fs`, `subprocess`, `shell`, and `tty` seams with routing versions. |
| [`terminal`](packages/terminal) | A terminal in the Web GUI's right Sidebar, one xterm.js tab per Session, in that Session's workspace — on whichever machine owns it. |
| [`tty`](packages/tty) | The terminal seam (`ctx.tty`): allocate a PTY, write to it, resize it, release it. |
| [`tty-local`](packages/tty-local) | A PTY this host owns, over node-pty. |
| [`tty-remote`](packages/tty-remote) | A PTY a node daemon owns, over the harness wire. |

The Rust agent the remote workspace installs on each machine lives in
[`agent/`](agent) and is released from this repository as a per-platform
`.tar.gz` plus `SHA256SUMS`.

## Layout

```
packages/           one npm workspace per plugin and per seam
agent/              the node daemon (Rust), built and released from here
tsconfig.base.json  compiler options every package extends
```

## Working on it

```sh
npm install                 # one install for every workspace
npm run build:agent         # the plugin's e2e suite drives this binary
npm run typecheck           # every package
npm test                    # builds, then every package's tests
npm run test:browser        # the settings section in a real Firefox
npm run test:agent          # the Rust agent's own tests
```

## Mounting a package

A deployment mounts a plugin by linking it into its profile and naming it in a
bundle or patch layer; libraries (`tty`, `tty-local`, `tty-remote`) arrive as
dependencies of the plugins that use them and are never listed themselves.

```json
{
  "dependencies": {
    "dsh-remote-workspace": "link:/path/to/this/repository/packages/remote-workspace",
    "dsh-terminal": "link:/path/to/this/repository/packages/terminal"
  }
}
```
