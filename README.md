# dsh-remote-worktree

Run the agent's file and shell tools on a **remote machine** instead of your laptop, and give each task its own isolated `git worktree` there.

The plugin replaces DeepSeek Harness's three execution-world seams — `ctx.fs`, `ctx.subprocess`, and `ctx.shell` — with routing versions. A path that belongs to a remote worktree is served by that machine's daemon; every other path is served by the shipped local implementation. The stock `read` / `write` / `edit` / `bash` / `grep` tools, the terminal, and the language servers therefore run against the remote checkout with **no new tools and no prompt conventions**.

## What you get

| Surface | Where |
|---|---|
| Machines: add by SSH destination, connect (forward opened for you), remove | Settings → Remote worktrees, or `/rwt nodes` |
| Repositories: register a checkout on a machine | Settings → Remote worktrees |
| Worktrees: create, list, merge back, remove | Settings → Remote worktrees, `/rwt`, or the `rw_*` tools |
| A remote worktree as a local workspace | `/rwt create` prints the local path; any session opened there works on the machine |
| Persistent terminals and language servers on the machine | the `terminal` tool and `lsp` run against the worktree like any other |

The settings section renders one tree — machine → the repositories registered on it → the worktrees cut from each repository — with live branch and cleanliness on every level.

## Install

Two pieces. The plugin goes into a Harness profile; the daemon goes onto every machine you want to work on.

```sh
# 1. the plugin: build it, then register it in the profile you run
git clone https://github.com/lengmoXXL/dsh-remote-ssh-worktrees.git
cd dsh-remote-ssh-worktrees
npm install && npm run build
dsh plugin --profile web add "$PWD"

# 2. the daemon, on each remote machine
npm install --global dsh-remote-worktree-agent
dsh-remote-agent --listen 127.0.0.1:7801 --token-file ~/.dsh-remote/token --root ~
```

Build outputs (`lib/`, `client/client.cjs`, `agent/lib/`) are not committed, so the profile has nothing to load until `npm run build` has run. The packaged daemon is published separately as `dsh-remote-worktree-agent`; a source checkout can also run it straight from `agent/lib/main.mjs` after a build.

Then open **Settings → Remote worktrees** and add the machine by its **SSH destination** — `user@host`, or an alias from `~/.ssh/config` — together with the port the daemon listens on there and the token it was started with.

### The forward is opened for you

You do not run `ssh -L` yourself. The daemon binds the machine's loopback, and the host picks a free local port, forwards it to the daemon's port over SSH, and dials through it — the same arrangement the VS Code Remote-SSH extension uses. The chosen port is shown next to the machine once it connects, and the forward is torn down when the machine is disconnected or the plugin unloads.

The host shells out to your own `ssh`, so `~/.ssh/config`, `ssh-agent`, `ProxyJump`, and bastion hosts all work as they already do. Authentication is key or agent only: nothing prompts for a password, so a machine that needs one must be unlocked in your agent first, and an unknown host key is refused with the command that would accept it rather than accepted silently.

Switching a machine to another destination is a `PATCH` that keeps its id, so the repositories and worktrees already anchored to it keep resolving.

### Why the daemon still binds loopback

It grants shell access as the user that runs it and carries no TLS of its own, so it is never exposed on its own. A non-loopback listener requires `--allow-remote` and is a deliberate, unsafe choice; the forward exists so you never need it. If the machine's `sshd` refuses TCP forwarding the connect fails with the setting to change (`AllowTcpForwarding yes`).

## Use

```
/rwt nodes                                       list machines and their connection state
/rwt create <nodeId> <repoPath> <name>           cut worktree/<name> from that repository
/rwt list                                        show every worktree with its state
/rwt bring-back <anchorId>                       merge the branch into the repository's current branch
/rwt remove <anchorId> [--force]                 remove the checkout and its branch
```

`/rwt create` prints two paths and you should know the difference:

- the **local path** is a real, empty directory — a *anchor*. It is what you open as a workspace and what every tool receives. Nothing is stored there.
- the **remote path** is the checkout on the machine, where the work actually happens.

The model sees the same vocabulary through `rw_list`, `rw_create`, `rw_bring_back`, and `rw_remove`.

## Design notes worth knowing

- **The harness stays local.** Model calls, the session log, plugins, and skills never move. Only the execution world does.
- **Nothing is inherited.** Each seam is a plain object registered with `ctx.provide` — the primitive Cordis' own `Service` constructor calls — and each shipped implementation is *composed* in an isolated scope and delegated to. The client-side `authority` and the local filesystem semantics are the shipped ones, not a reimplementation.
- **The daemon is a plain Node program.** It depends on neither Cordis nor any `@deepseek-ai/*` package, so it cannot drift with the Harness.
- **A remote world is not sandboxed.** `ctx.sandbox` wraps processes for *this* host's kernel, so it cannot confine a process on another machine. The machine is the boundary, and the approval policy is the tripwire.

## Verification

Everything the plugin does has been exercised against a real second host — a Linux VM reached through an SSH tunnel, which is the documented deployment — not only against a daemon on loopback: handshake, guarded file writes, commands running as the remote user in the remote working directory, live piped stdout crossing the network while the child still runs, a `git worktree` cut and removed through the plugin's own lifecycle, and a PTY allocated and answering on the machine.

The browser half is verified against a real shell too, not only against its own artifact: booting a Harness with this plugin composed shows the shell discovering the `dsh.client` manifest, assigning it a revision, carrying its `inject` list into the boot payload, and serving the bundle from `/plugins/??dsh-remote-worktree/client.js` with the module wrapper the loader expects. Booting that shell is also what caught the one defect the artifact checks could not: the routers originally reported no sandbox mode, and the shipped base refuses to compose a mount that claims not to confine, so the plugin could not load in a real profile at all.

The whole management path has been driven through the Web routes a browser calls, against that same machine: add a machine, connect it, browse `/workspace`, register a repository, cut a worktree from it, and then open a session whose working directory is the returned anchor. That session's own `read` tool returned a file that exists **only** on the machine, and its `bash` reported the machine's working directory — the anchor directory holds nothing but metadata on this host.

`scripts/verify-remote-host.ts` reproduces the cross-machine pass against any host:

```sh
ssh -N -L 14780:127.0.0.1:47801 admin@<host> &
node scripts/verify-remote-host.ts 14780 <token-file>
```

## Requirements

- Harness `0.1.5-rc.1` or later.
- Node `^22.19 || >=24` on both sides.
- `node-pty` on the machine (installed with the daemon) for terminal support — it ships prebuilds, so no compiler is needed.
- `git` on the machine for the worktree lifecycle.

## Model Experience

### Remote worktree tools

#### What the model sees

Four tools are registered when a session runs: `rw_list`, `rw_create`,
`rw_bring_back`, and `rw_remove`. Each takes string identifiers — a machine id,
an absolute repository path, and a worktree name — and returns the local anchor
path of the worktree it acted on. Their schemas and prose live in
[`src/tools.ts`](src/tools.ts).

#### Token effect

Fixed per turn while the plugin is mounted: four tool schemas are present in
every request whether or not the model uses them, in proportion to the rendered
schema length. Unmounting the plugin removes all four.

#### KV Cache effect

Prefix-stable. The schemas and their order do not depend on session data, so a
request prefix that included them stays reusable across turns. A `rw_*` result
is an ordinary tool result appended after the cached prefix and does not
invalidate it.

### Stock tools routed to a machine

#### What the model sees

`read`, `write`, `edit`, `bash`, `grep`, glob, and the terminal run against the
machine for any path under a registered anchor, with no change to their schemas
or prompts. What changes is the data: results carry **machine** paths (for
example `/workspace/app/src/main.ts`) rather than local ones, and the process
facts a `bash` result reports — user, working directory, exit status — describe
the machine.

#### Token effect

Zero direct effect. The plugin contributes no prompt text of its own; only the
tool results a session already produces change content.

#### KV Cache effect

Append-only. The routed results are ordinary tool results, so they extend the
transcript without replacing earlier request tokens. Because the same content is
never produced twice, a routed result does not itself invalidate reuse.

## Known Limitations and Deferred Work

- **A stalled piped stream costs the process, not the daemon.** Raw `stdout`/`stderr` is pushed, so a consumer that stops reading would otherwise grow the daemon's memory without bound. After 64 unacknowledged frames on one stream (about 4 MiB) the daemon stops sending that process's frames and terminates it. The client can see the gap from the last sequence number it received; a terminated process is recoverable where an exhausted daemon is not.
- **Termination reports a killed process, not a clean exit.** The managed ladder ends in `SIGKILL`, so a terminal or process torn down through it reports `null`/non-zero rather than `0`.
- **Spill files stay on the machine.** Collected output beyond its in-memory cap is retained as a bounded tail; the full stream is not fetched to the host.
- **An attachment cannot be read remotely.** The Harness resolves an image or file from a host path, which names a file this world cannot read; the failure surfaces at the daemon rather than as a wrong file.
- **The client surface is a settings section only.** There is no directory-flow integration, so a worktree is opened by its printed local path. The section's directory picker lists through the same remote filesystem a session sees, so what it shows is what a session opened on the result would read.
- **No `./invariant` is published.** The convention reserves that entry for relationships two independent observations can disagree about. Every relation this package owns has one observer: the routers and the node registry are the only readers of the anchor routes, and the daemon is the only authority on a machine path. A check here could only assert that the code agrees with itself, which the tests already do.
