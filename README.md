# dsh-remote-workspace

Work on another machine from the harness: manage its repositories and worktrees, run the file, shell, and terminal
tools inside them, and open a terminal in the Web GUI's right Sidebar. The model sees ordinary local paths — the plugin
routes each one to the machine that owns it.

English | [中文](README.zh.md)

![A session running tools inside a remote worktree](docs/screenshots/en/08-session.png)

| Machines | Connected | A worktree |
| --- | --- | --- |
| ![The machine list](docs/screenshots/en/01-section.png) | ![A connected machine and its repository](docs/screenshots/en/03-connected.png) | ![A created worktree](docs/screenshots/en/06-worktree-created.png) |

## Requirements

- Node 22.19+ or 24+, with `ssh` configured as usual.
- DSH `0.1.5-rc.2` — verified in a disposable profile; other releases are untested.
- Nothing to install on the machines: the plugin fetches its agent from this repository's Releases, keeps it up to
  date, and reaches it over `ssh -L`, so a connection is only as trusted as your own SSH access.

## Install

```sh
dsh plugin --profile web add https://github.com/lengmoXXL/dsh-remote-workspace/releases/download/plugin-v0.1.0/dsh-remote-workspace-0.1.0.tgz
```

The tarball carries the built `lib/`, so the machine that installs it compiles nothing. While developing the plugin,
install from a checkout instead: `git clone`, `npm install && npm run build`, then
`dsh plugin --profile web add "$PWD"`.

This plugin routes services the base profile provides, and the host plane holds one implementation per service, so its
own patch layer cannot free them: add these four lines to `$DSH_HOME/profiles/web/cordis.patch.yml` too. Without them
the plugin still loads, and says on stderr that its routers are inert.

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

Then start the profile with `dsh --profile web`.

## What you can do

- Add a machine over SSH — `user@host` or a `~/.ssh/config` alias — or use the built-in `Local` machine for this host.
- Register any directory on a machine as a repository; git is not required.
- Cut a worktree from a repository and open it as a workspace; the checkout path is filled in and can be changed.
- Adopt a worktree that already exists on the machine, and release it later without deleting anything.
- Open a plain directory as a workspace, `git init` it later, and keep working in it.
- Run read, write, edit, bash, grep, and terminal tools in a workspace, on the machine that owns it.
- Open a terminal tab in the right Sidebar: the machine's own login shell in the Session's workspace, which survives
  hiding the tab, switching Session, or collapsing the sidebar, follows the panel's size, and is not confined by the
  Session's sandbox mode — it is your shell, not the agent's.

## Usage

**Settings → Remote workspaces.** Add a machine by SSH destination and token — the daemon's shared secret, any string.
`Local` is always first and needs neither. Machines connect on their own; one that stays unreachable shows a
**Connect** button. Register a repository, then use each row's menu to open, close, or remove what it holds. A workspace
opened here appears in Sessions, and its tools and terminals run on the machine that owns it.

**The terminal.** The right Sidebar's add control lists a **Terminal** button; each Session gets its own tab, opened in
that Session's workspace. Closing the tab ends the shell.

## Config

| Field | Default | Meaning |
|---|---|---|
| `worktreeRoot` | `~/.dsh/worktrees` | Root every managed checkout is cut under, on every machine. |
| `shell` | unset | Program the Sidebar terminal runs; unset uses the machine's own login shell. |
| `shellArgs` | `['-l']` | Arguments after `shell`; ignored while `shell` is unset. |
| `graceMs` | `3000` | How long a closing terminal is given to exit, in milliseconds. |

MIT
