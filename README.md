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

- Node 22.19+ or 24+, and `ssh` configured as usual.
- DSH `0.1.5-rc.2`, verified in a disposable profile; other releases are untested.
- Nothing to install on the machines: the plugin fetches the agent and keeps it up to date.

## Install

```sh
dsh plugin --profile web add https://github.com/lengmoXXL/dsh-remote-workspace/releases/download/plugin-v0.1.0/dsh-remote-workspace-0.1.0.tgz
```

The tarball carries the built `lib/`, so the machine that installs it compiles nothing.

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

Working on the plugin itself, or installing from a checkout:

```sh
git clone https://github.com/lengmoXXL/dsh-remote-workspace
cd dsh-remote-workspace && npm install && npm run build
dsh plugin --profile web add "$PWD"
```

`dsh plugin --profile web add github:lengmoXXL/dsh-remote-workspace` works too — the plugin builds itself through its
`prepare` script — but pnpm refuses that script until the exact commit is allowlisted, which is why the release tarball
is the shorter path.

## What you can do

- Adopt a worktree that already exists on the machine, and release it later without deleting anything.
- Open a plain directory as a workspace; `git init` it later and cut worktrees from it.
- Run read, write, edit, bash, grep, and terminal tools in the workspace, on the machine that owns it.
- Open a terminal tab in the right Sidebar: it starts the machine's own login shell in the Session's workspace, keeps
  running while you hide the tab, switch Session, or collapse the sidebar, and follows the panel's size. It is your
  shell, so the Session's sandbox mode does not confine it.

## Usage

**Settings → Remote workspaces.**

1. Add a machine by SSH destination and token. The token is the daemon's shared secret and may be any string.
   Machines connect on their own; one that stays unreachable shows a **Connect** button.
2. `Local` is always first and needs neither a destination nor a token.
3. Register a repository, then use each row's menu to open, close, or remove what it holds.
4. A workspace you open here is available to Sessions, and its tools and terminals run on the machine that owns it.

**The terminal.** The right Sidebar's add control lists a **Terminal** button. Each Session gets its own tab, opened in
that Session's workspace — on this host or on the machine that owns it. Closing the tab ends the shell; a closed
browser tab leaves none behind.

## Config

| Field | Default | Meaning |
|---|---|---|
| `worktreeRoot` | `~/.dsh/worktrees` | Root every managed checkout is cut under, on every machine. A checkout lands at `<root>/<repository>/<name>`. |
| `shell` | unset | Program the Sidebar terminal runs. Unset uses the machine's own login shell. |
| `shellArgs` | `['-l']` | Arguments after `shell`; ignored while `shell` is unset. |
| `graceMs` | `3000` | How long a closing terminal is given to exit, in milliseconds. |

## Notes

- The agent is downloaded from this repository's Releases, checked against `SHA256SUMS`, and reached over `ssh -L`,
  so a connection has the trust of your own SSH access.

MIT
