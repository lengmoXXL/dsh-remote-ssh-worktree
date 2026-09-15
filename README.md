# dsh-remote-workspace

Run the harness's tools on another machine: its repositories and worktrees, and a terminal you both use. The model
sees ordinary local paths — the plugin routes each one to the machine that owns it.

**The three things this gives you**

- **Work where the code is.** Any directory on a machine — a repository, a worktree cut from it, or a plain folder —
  becomes a workspace, and read/write/edit/bash/grep all run there, not on this host.
- **One terminal, two users.** The right Sidebar's terminal belongs to the Session, and the agent can drive the same
  one: list the open terminals, read their output, type text and keys (including `ctrl+c`), and wait for something to
  appear. You watch every keystroke as it happens.
- **One command, nothing on the machines.** Install the plugin and point it at a host over SSH; the agent it needs is
  fetched from Releases, verified, and reached over `ssh -L` — so a connection is as trusted as your own SSH access.

English | [中文](README.zh.md)

![A session running tools inside a remote worktree](docs/screenshots/en/08-session.png)

| Machines | Connected | A worktree |
| --- | --- | --- |
| ![The machine list](docs/screenshots/en/01-section.png) | ![A connected machine and its repository](docs/screenshots/en/03-connected.png) | ![A created worktree](docs/screenshots/en/06-worktree-created.png) |

## Requirements

- Node 22.19+ or 24+, with `ssh` configured as usual.
- DSH `0.1.5-rc.2` — verified in a disposable profile; other releases are untested.

## Install

```sh
dsh plugin --profile web add https://github.com/lengmoXXL/dsh-remote-workspace/releases/download/plugin-v0.1.2/dsh-remote-workspace-0.1.2.tgz
```

Then add these four lines to `$DSH_HOME/profiles/web/cordis.patch.yml` — **the install is not complete without them**:
the plugin routes services the base profile provides, and the host plane holds one implementation per service, so the
deployment has to free them. Skip this and the plugin still loads, but says on stderr that its routers are inert.

```yaml
- id: subprocess
  disabled: true
- id: fs-sandbox
  disabled: true
- id: bash-sandbox
  disabled: true
- id: pwsh-sandbox
  disabled: true
```

Start the profile with `dsh --profile web`. The tarball carries the built `lib/`, so nothing is compiled here; while
developing the plugin, `git clone`, `npm install && npm run build`, and `dsh plugin --profile web add "$PWD"` instead.

## What you can do

- Add a machine over SSH — `user@host` or a `~/.ssh/config` alias — or use the built-in `Local` machine for this host.
- Register any directory as a repository; git is not required. Cut a worktree from it, adopt one that already exists,
  or open the directory itself. Remove what you no longer need, with or without its branch.
- Work in a routed workspace from a Session: its tools, its terminal, and its files all live on the machine that owns
  it, while the paths you and the model see stay ordinary local paths.
- Ask the agent to work in a terminal: it lists the Session's open terminals (each tab has its own id), reads their
  output, types text and keys, and waits for output — the same shell you are watching, so you see it happen and it sees
  what you type.
- Keep the terminal as your own: it is not confined by the Session's sandbox mode, and the agent never creates or kills
  one.

## Usage

**Settings → Remote workspaces.** Add a machine by SSH destination and token — the daemon's shared secret, any string.
`Local` is always first and needs neither. Machines connect on their own; one that stays unreachable shows a
**Connect** button. Register a repository, then use each row's menu to open, close, or remove what it holds.

**The terminal.** The right Sidebar's add control lists a **Terminal** button; each Session gets its own tab, opened in
that Session's workspace. You can open several: each tab is a separate terminal with its own id, so you and the agent
can tell them apart. A terminal lives exactly as long as its tab — **closing the tab ends that shell**, while hiding the
tab, switching Session, or collapsing the sidebar leaves it running.

## Config

| Field | Default | Meaning |
|---|---|---|
| `worktreeRoot` | `~/.dsh/worktrees` | Root every managed checkout is cut under, on every machine. |
| `shell` | unset | Program the Sidebar terminal runs; unset uses the machine's own login shell. |
| `shellArgs` | `['-l']` | Arguments after `shell`; ignored while `shell` is unset. |
| `graceMs` | `3000` | How long a closing terminal is given to exit, in milliseconds. |

MIT
