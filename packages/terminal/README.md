# dsh-terminal

English | [中文](README.zh.md)

A terminal in the DeepSeek Harness Web GUI's **right Sidebar**, drawn with
[xterm.js](https://xtermjs.org/) and backed by a real PTY.

Open the column's add control and the guide lists a **Terminal** capsule beside
the Files and Git ones — the same two-stage registration those types use, so
nothing about the column is special-cased for this plugin.

## What opens

A shell in the Session's own workspace directory. The browser sends a Session
identity and never a path: the host resolves the workspace from that Session's
header, exactly as every other workspace-scoped reader does, and allocates the
terminal through `ctx.tty`.

That one seam is the whole remote story. A workspace routed by
[dsh-remote-workspace](../remote-workspace) — the other plugin in this
repository — is named by its local anchor path, so the routing terminal provider
resolves that path to its node and starts the shell **there**: same code path, no
knowledge of machines here. With no router composed every workspace is simply
local, and [dsh-tty-local](../tty-local) is what answers. The seam itself is
[dsh-tty](../tty), and a node's terminal is reached through
[dsh-tty-remote](../tty-remote).

The shell is the machine's own login shell, resolved on whichever machine owns
the workspace: argv is `/bin/sh -c 'exec "${SHELL:-/bin/sh}" -l'`, so a
deployment spanning a Mac and a Linux node starts zsh on one and bash on the
other. Set `shell` and `shellArgs` to pin one instead.

## Terminal lifetime

One socket is one terminal. The browser keeps its xterm instance, scrollback,
DOM element, and socket in a per-tab entry that outlives the React body — the
right Sidebar renders only its active tab, so a terminal that died with its
component would lose the shell on every tab switch. Hiding the tab, switching
Session, or collapsing the column therefore costs nothing; closing the tab
record — whose abort signal is the only thing that tears the entry down — closes
the socket, and the host kills the PTY. A closed browser tab leaves no shell
behind.

## Resizing

The panel's measured box drives the PTY: a `ResizeObserver` fits xterm, and the
new size is sent to the host on every change.

`resize` is a verb of the terminal seam (`ctx.tty`), so the host applies it
without asking what kind of provider answered: the local one sets the PTY's
window size, and a node's terminal is resized through `term.resize`, which the
remote agent gained in **0.0.2**. A provider that refuses — a node still running
0.0.1 — leaves the terminal at the size it was opened with, and the status line
says so rather than leaving a stale layout unexplained.

## Sandboxing

The terminal is **not** confined by the Session's sandbox mode. That policy
bounds what the agent may do; a terminal is the person's own shell, started by
the person, which is how every editor's terminal behaves. There is also a
mechanical reason: `ctx.sandbox` builds a wrap for **this** host's kernel, so
applying it to a workspace that belongs to another machine would ship
`sandbox-exec` or `bwrap` to a node that has neither.

## Install

The plugin is mounted as one Loader row. Two ways in, pick one:

**As a bundle** — the shape a published plugin uses. Add the dependency and the
bundle to the profile, then restart the server:

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dsh": { "profile": { "bundles": ["…", "dsh-terminal"] } },
  "dependencies": { "dsh-terminal": "link:/Users/lzy/Projects/dsh-terminal" }
}
```

```sh
dsh plugin --profile web install          # links the package
```

**Through the profile's patch layer** — the shape used while developing it.
`$DSH_HOME/profiles/<name>/cordis.patch.yml` is watched live
(`patchReload: live`), so the host half mounts without a restart:

```yaml
- insert:
    - id: dsh-terminal
      name: dsh-terminal
```

Do not do both: the row would be inserted twice. The plugin ships its own
`cordis.patch.yml`, which is what makes the bundle route work; naming it in
`bundles` *and* inserting it by hand is a composition error.

The client half is a dynamic bundle the shell fetches from
`/plugins/??dsh-terminal/client.js`. A page already open keeps the bundle it
loaded, so a rebuild needs a reload — the loader re-hashes the artifact and the
refresh picks up the new revision.

## Config

| Field | Default | Meaning |
|---|---|---|
| `shell` | unset | Program to run. Unset runs the machine's own login shell. |
| `shellArgs` | `['-l']` | Arguments after `shell`. Ignored while `shell` is unset. |
| `graceMs` | `3000` | TERM-to-KILL grace for one terminal session. |

## Wire

One WebSocket at `/dsh-terminal/ws`, fenced by the same browser-trust check as
every `/api` request — a handshake carries cookies and is not covered by
same-origin, so without that fence any page in the browser could open a shell.

Text frames carry JSON control (`open`, `input`, `resize` up; `ready`, `size`,
`exit`, `error` down) and **binary** frames carry raw terminal bytes down, so a
shell's output is not base64-encoded per chunk. Output is paced one chunk at a
time: a flooding command pauses the PTY's output stream rather than growing an
unbounded queue in the host process.

## Development

```sh
npm install
npm run typecheck    # host and client halves
npm test             # unit tests
npm run build        # lib/index.js (host) + lib/client.js (browser bundle)
npm run watch        # rebuild the client half on change
```
