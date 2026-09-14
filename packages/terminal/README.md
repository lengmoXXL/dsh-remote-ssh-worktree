# dsh-terminal

A terminal in the Web GUI's right Sidebar: one xterm.js tab per Session, opened in that Session's workspace — on
this host or on the machine that owns it. Sibling package: [remote-workspace](../remote-workspace).

English | [中文](README.zh.md)

## What it does

- Opens the machine's own login shell in the Session's workspace directory. `shell` and `shellArgs` pin a program
  instead.
- Keeps the shell while you hide the tab, switch Session, or collapse the sidebar; closing the tab ends it, and a
  closed browser tab leaves no shell behind.
- Follows the panel's size. Resizing works on this host and on a node; if a machine cannot resize, the status line
  says the size is stale.
- Is not confined by the Session's sandbox mode — it is your shell, not the agent's.

## Install

Mount it as one Loader row.

As a bundle:

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dsh": { "profile": { "bundles": ["…", "dsh-terminal"] } },
  "dependencies": { "dsh-terminal": "link:/path/to/dsh-remote-workspace/packages/terminal" }
}
```

```sh
dsh plugin --profile web install
```

Or, while developing it, through the profile's patch layer
(`$DSH_HOME/profiles/<name>/cordis.patch.yml`, watched live — no restart):

```yaml
- insert:
    - id: dsh-terminal
      name: dsh-terminal
```

Use one of the two: naming it in `bundles` *and* inserting it by hand mounts the row twice. After a rebuild, reload
the page — an open page keeps the client bundle it loaded.

## Config

| Field | Default | Meaning |
|---|---|---|
| `shell` | unset | Program to run. Unset uses the machine's own login shell. |
| `shellArgs` | `['-l']` | Arguments after `shell`; ignored while `shell` is unset. |
| `graceMs` | `3000` | How long a closing terminal is given to exit, in milliseconds. |

MIT
