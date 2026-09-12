# dsh-remote-ssh-worktree

A DSH plugin that runs the harness's file, shell, and terminal tools inside a git worktree on a remote
machine.

English | [中文](README.zh.md)

![A session in a remote worktree, running tools on that machine](docs/screenshots/en/08-session.png)

| Machines | Connected | A worktree |
| --- | --- | --- |
| ![The machine list](docs/screenshots/en/01-section.png) | ![A connected machine and its repository](docs/screenshots/en/03-connected.png) | ![A created worktree](docs/screenshots/en/06-worktree-created.png) |

## What it does

- Reaches a machine over SSH — `user@host` or a `~/.ssh/config` alias. Nothing to install there by hand.
- Cuts `worktree/<name>` from any git repository on the machine and registers the checkout as a DSH workspace; one row
  opens, closes, or removes each worktree.
- Opens a directory that is not a git repository as a workspace in its own right; initialize it on the machine and
  worktrees can be cut from it without registering anything again.
- Read, write, edit, bash, grep, and terminal tools then run on that machine, unchanged. The model never sees
  that the files are remote.
- Removing one takes the checkout and leaves the branch, so an unmerged commit is never lost silently.

## How it works

- The plugin replaces the harness's `fs`, `subprocess`, and `shell` seams with routing versions: a path under a
  remote anchor goes to that machine's agent, every other path stays local.
- The agent is one statically linked Rust binary. It binds a kernel-assigned loopback port and publishes it in a
  state file, so a machine is configured by its SSH destination and a token alone — there is no port to agree on.
- The plugin installs and updates it: on connect it reads `uname`, downloads the matching build from this
  repository's GitHub Releases, verifies it against `SHA256SUMS`, uploads it over the same SSH connection, starts
  it detached, then forwards to the port it published.
- Agent traffic reaches your machine through `ssh -L`, so a connection has exactly the trust of your own SSH
  access.

## Architecture

```text
┌─ browser ──────────────────────────────────────────────────┐
│  plugin/client    the settings section                     │
└──────────────────────────────┬─────────────────────────────┘
                               │ management API over HTTP
┌─ plugin/   the DSH surfaces ─▼─────────────────────────────┐
│  api · tools · commands       over the models              │
│  routing/  fs · subprocess · shell seams → the SDK         │
└──────────────────────────────┬─────────────────────────────┘
                               │
┌─ models/   the business semantics ─────────────────────────┐
│  worktrees · machines · autoconnect                        │
│  routing   which execution world a path belongs to         │
└─────────────┬───────────────────────────────┬──────────────┘
              │ state                         │ the SDK
┌─ storage/ ───────────────┐  ┌─ remote/   the SDK ──────────┐
│  durable state           │  │  channel · protocol          │
│  anchors · nodes · repos │  │  ssh · agent install         │
│  document: lock + atomic │  │  one channel per machine     │
└──────────────────────────┘  └───────────────┬──────────────┘
                                              │ ssh -L, JSON-RPC 2.0
                              ┌─ machines — one or more ─────┐
                              │  dsh-remote-agent (Rust)     │
                              │  random loopback port        │
                              └──────────────────────────────┘
```

`remote/` turns a machine's daemon into an SDK; `storage/` keeps what has to survive a restart; `models/` is the business
semantics built on both; `plugin/` is the only layer that knows DSH. Imports only ever point downward, `src/index.ts` is
the one file that assembles the layers, and `ids.ts` is the one vocabulary they all share. The settings section is the
other half — it runs in the browser and reaches the host through its management API.

## Install

```sh
git clone https://github.com/lengmoXXL/dsh-remote-ssh-worktree
cd dsh-remote-ssh-worktree && npm install && npm run build
dsh plugin --profile web add "$PWD"
dsh --profile web
```

## License

MIT
