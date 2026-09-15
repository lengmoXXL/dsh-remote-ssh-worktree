# dsh-remote-workspace

DSH plugins for working on a remote machine: manage its repositories and worktrees, and open a terminal there.

English | [中文](README.zh.md)

| Package | What you get |
| --- | --- |
| [`remote-workspace`](packages/remote-workspace) | A **Remote workspaces** settings section: add machines over SSH, register their repositories, create or adopt worktrees, and run the harness's tools inside them. |
| [`terminal`](packages/terminal) | A terminal tab in the right Sidebar, opened in the Session's workspace — on this host or on a node. |
| [`tty`](packages/tty) · [`tty-local`](packages/tty-local) | The terminal seam and its local provider. `remote-workspace` carries the remote one. |

## Install

```sh
git clone https://github.com/lengmoXXL/dsh-remote-workspace
cd dsh-remote-workspace && npm install && npm run build
dsh plugin --profile web add "$PWD/packages/remote-workspace" "$PWD/packages/terminal"
```

`remote-workspace` routes services the base profile provides, and the host plane holds one implementation per service,
so its own patch layer cannot free them: add these four lines to `$DSH_HOME/profiles/web/cordis.patch.yml` before
starting the profile. Without them the plugin loads and reports that its routers are inert.

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

Restart the server to load them.

MIT
