# dsh-remote-ssh-worktree

Run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) tools inside a git worktree on a
remote machine.

English | [中文](README.zh.md)

![The Remote worktrees section](docs/screenshots/en/06-worktree-created.png)

## What it is

A DSH plugin. It replaces the harness's file, subprocess, and shell seams with routing versions: a path that
belongs to a remote anchor is served by that machine's agent over the wire, and every other path is served
locally. A worktree cut on the machine is registered as an ordinary DSH workspace, so the stock read, write,
edit, bash, grep, and terminal tools run there unchanged — the model never sees that the files are not local.

- The agent on the machine is one statically linked Rust binary. Nothing has to exist there beforehand except
  SSH access and `git`.
- The plugin installs and updates that binary itself. On connect it reads the machine's `uname`, fetches the
  matching build from this repository's GitHub Releases, verifies it against `SHA256SUMS`, uploads it over the
  same SSH connection, starts it, and forwards to the port it published.
- The agent binds a kernel-assigned loopback port and publishes it in a state file, so a machine is configured
  by its SSH destination and a token alone — there is no port to agree on.

## Requirements

- DSH with a Web profile: the management surface is a settings section.
- A machine running Linux or macOS on x86_64 or aarch64, reachable over SSH with a key (a password is never
  prompted for) and with `git` installed.
- Access to `api.github.com` from the machine that runs DSH, the first time each agent version is fetched. The
  binaries are cached on the host afterwards.

## Install

The package is not on npm yet, so install it from a checkout:

```sh
git clone https://github.com/lengmoXXL/dsh-remote-ssh-worktree
cd dsh-remote-ssh-worktree
npm install
npm run build
dsh plugin --profile web add "$PWD"
```

`dsh plugin` forwards to pnpm inside the profile directory and appends the bundle to `dsh.profile.bundles`. The
first use initializes the profile — with `@deepseek-ai/dsh-base` and the Web app — if it does not exist yet.
Then boot it:

```sh
dsh --profile web
```

Once the package is published to npm, the same install is
`dsh plugin --profile web add dsh-remote-ssh-worktree`. To remove it again:
`dsh plugin --profile web remove dsh-remote-ssh-worktree`.

## Use

1. **Add machine.** Settings → Remote worktrees → Add machine. Give the SSH destination (`user@host`, or an
   alias from `~/.ssh/config`), optionally an SSH port and identity file, and an access token — any secret you
   choose. The plugin writes that token to the machine and both sides authenticate with it.
2. **Connect.** The first connect installs `~/.dsh/remote-agent/dsh-remote-agent` on the machine, starts it
   detached, and forwards to the port it published. Later connects reuse it, and a newer agent version in the
   plugin replaces it on the next connect.
3. **Add repository.** An absolute path on the machine that is already a git checkout; it is verified with
   `git` before anything is stored.
4. **New worktree.** Cuts `worktree/<name>` from the repository's current HEAD and registers the checkout as a
   DSH workspace. Open that workspace and the file, shell, and terminal tools run on the machine.
5. **Merge back.** Merges the worktree's branch into the repository's current branch, aborting a conflicted
   merge instead of leaving the repository mid-merge.

| Machines | Connected | A worktree |
| --- | --- | --- |
| ![The machine list](docs/screenshots/en/01-section.png) | ![A connected machine with its repository](docs/screenshots/en/03-connected.png) | ![A created worktree](docs/screenshots/en/06-worktree-created.png) |

## What runs where

- On the machine: `~/.dsh/remote-agent/dsh-remote-agent` (the binary), `token` (mode 600), `state.json` (the
  published port and build identity), and `agent.log`.
- The agent binds `127.0.0.1` only. Its traffic arrives through an `ssh -L` forward this plugin opens from your
  machine, so a connection has exactly the trust of your own SSH access and nothing listens publicly.
- The agent serves the filesystem, git, subprocesses, and PTYs as the remote user. Treat its token the way you
  would treat shell access to that machine.

## Development

```sh
npm install
npm run typecheck      # TypeScript, host and browser halves
npm run build
npm test               # unit and e2e; the e2e suites drive the compiled agent
npm run build:agent    # cargo build --release -p dsh-remote-agent
cargo test --all       # the agent's own tests
npm run test:browser   # Firefox 129+, boots a disposable deployment
```

`npm test` needs the agent binary: `npm run build:agent` produces it, or point `DSH_REMOTE_AGENT_BIN` at one.
The browser test writes screenshots to `.artifacts/browser`; set `RWT_ACCEPT_LANGUAGES` to render the UI in
another language.

## Releasing an agent update

1. Bump `version` in `agent/Cargo.toml` and `AGENT_VERSION` in `src/agent/version.ts` — a test keeps them equal.
2. Commit, then tag `v<version>` and push the tag. `.github/workflows/release.yml` refuses a tag that disagrees
   with the manifest, builds the four static binaries, and publishes them with `SHA256SUMS`.
3. Every host picks the new build up on its next connect, reusing its cached download when it already has it.

## License

MIT
