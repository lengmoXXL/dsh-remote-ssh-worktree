# dsh-remote-workspace

DSH plugins for working on a remote machine: manage its repositories and worktrees, and open a terminal there.

English | [中文](README.zh.md)

| Package | What you get |
| --- | --- |
| [`remote-workspace`](packages/remote-workspace) | A **Remote workspaces** settings section: add machines over SSH, register their repositories, create or adopt worktrees, and run the harness's tools inside them. |
| [`terminal`](packages/terminal) | A terminal tab in the right Sidebar, opened in the Session's workspace — on this host or on a node. |
| [`tty`](packages/tty) · [`tty-local`](packages/tty-local) · [`tty-remote`](packages/tty-remote) | The terminal seam and its two providers. Only a deployment that mounts providers itself needs these. |

## Add to a deployment

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-remote-workspace": "link:/path/to/repo/packages/remote-workspace",
    "dsh-terminal": "link:/path/to/repo/packages/terminal"
  }
}
```

Name each plugin in the profile's `bundles` or in its `cordis.patch.yml`, then restart the server.

MIT
