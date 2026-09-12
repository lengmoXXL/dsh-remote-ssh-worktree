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
- Cuts `worktree/<name>` from any git repository on the machine and registers the checkout as a DSH workspace.
- Read, write, edit, bash, grep, and terminal tools then run on that machine, unchanged. The model never sees
  that the files are remote.
- Merges the worktree branch back into the repository's branch, aborting a conflicted merge instead of leaving
  the repository mid-merge.

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

## Install

```sh
git clone https://github.com/lengmoXXL/dsh-remote-ssh-worktree
cd dsh-remote-ssh-worktree && npm install && npm run build
dsh plugin --profile web add "$PWD"
dsh --profile web
```

## License

MIT
