# AGENTS.md

Development guidance for this repository. It is an **out-of-tree** DeepSeek
Harness plugin, not a package of the Harness monorepo, so this file states which
Harness conventions apply here, which do not, and where the authority for each
one lives.

## What this repository is

One plugin bundle with three runtime faces and one wire contract:

| Path | Face |
|---|---|
| `src/` | Host half: the Cordis plugin that replaces the execution-world seams |
| `client/` | Browser half: the settings section, built as one dynamic CJS factory |
| `agent/` | The daemon that runs on each managed machine, a plain Node program |
| `shared/protocol.ts` | The wire contract both halves and the daemon inline |
| `DESIGN.md` | Why the plugin is shaped this way (Chinese; the design record) |

A profile loads it through `dsh plugin --profile <name> add <path>`, which
records a `link:` dependency. Build outputs (`lib/`, `client/client.cjs`,
`agent/lib/`) are gitignored but **must exist on disk** for a profile to load
the plugin, and several suites read them.

## Commands

```sh
npm ci                 # from a clean checkout
npm run typecheck      # all three faces: host, agent, client
npm run test           # host suite
npm run test:agent     # daemon suite
npm run test:all       # both
npm run build          # host + client + agent artifacts
```

The bundle and built-daemon suites read `client/client.cjs` and
`agent/lib/main.mjs`, so **`npm run build` must precede `npm run test:all`** on a
clean checkout. CI does this; a bare `npm test` on a fresh clone will fail
without its naming the reason.

`.github/workflows/ci.yml` runs typecheck, build, an artifact-existence check,
and both suites on Node 22 and 24. Keep it green; it has already caught defects
that do not reproduce on macOS.

## Authority

The Harness repository is the single home for the conventions this plugin
follows. Read the rule there before changing behavior; do not restate it here.

| Authority | What it owns |
|---|---|
| `<harness>/AGENTS.md` | Repo-wide conventions, prose standard, dependencies |
| `<harness>/packages/AGENTS.md` | Plugin/package rules, README format, testing policy |
| `<harness>/packages/client/AGENTS.md` | Slot discipline, export discipline, styling, i18n |
| `<harness>/docs/web-styling.md` | `--dsw-*` tokens, border widths, CSS Modules |
| `<harness>/docs/testing.md` | Test tiers and what a real-composition test is |
| `<harness>/docs/defensive-patterns.md` | Lifecycle, concurrency, subprocess, teardown |

`<harness>` is the checkout of `deepseek-harness` on this machine, not a path
inside this repository.

## Rules that apply here

**Export discipline.** The host half named-exports `name`, `inject`, `Config`,
and `apply`, and never a default export — a default export makes the Loader
discard the namespace and its `inject`. The client half exports only `apply`,
`inject`, and `name`; a test asserts exactly that key set.

**Services.** Declared dependencies use the `ctx.<name>` property proxy;
optional ones use `ctx.get(name)`, which reads the global store rather than a
topology-sensitive proxy. Registrations go through `ctx.effect()` and return the
disposer. `ctx.tools.register` and `ctx.commands.register` already ride the
calling fiber, so wrapping them again is unnecessary.

**Opaque ids are branded.** `NodeId`, `RepoId`, and `AnchorId` live in
`src/ids.ts`; `ProcId` and `TermId` live in `shared/protocol.ts`. A string
becomes one of them only at a boundary — a parsed document, a route segment, a
routing key, a tool or command argument — through `asNodeId` / `asRepoId` /
`asAnchorId` / `asProcId` / `asTermId`. Everything downstream carries the type.
A function that receives an id types the parameter as that id, never `string`.

**The protocol imports nothing.** `shared/protocol.ts` has no imports on
purpose: the daemon must not depend on Cordis or any `@deepseek-ai/*` package,
so it cannot drift with the Harness. That is why `ProcId` and `TermId` use a
locally declared `unique symbol` brand instead of `@deepseek-ai/dsh-brand`.
Verify with `grep -c '^import' shared/protocol.ts` and by checking the built
`agent/lib/main.mjs` for `@deepseek-ai/` specifiers.

**Closed unions end in an unreachable arm.** `switch` over a closed union
terminates with an assignability check (`const mode: never = …`) or
`assertNever`, never a silent default.

**Comments state contracts, not reasoning.** An empty `catch` names what it
swallows and why nothing else can reach it; a `try` with an empty `catch` holds
one statement. Avoid `contract`, `boundary`, and `shape` where a more exact term
names the subject.

**Client copy is locale-owned.** Every product-visible string — text,
`placeholder`, `title`, `aria-label`, `closeLabel` — reaches the component
through `t`. The `zh` dictionary is the key source and `en` is checked against
it. The harness's `findUiI18nViolations` reports zero for `client/`; keep it
there.

**Styling.** CSS Modules compiled by the client build, `--dsw-*` semantic tokens
only, no literal colours. Neutral `--dsw-alias-border-*` borders draw at `0.5px`;
state-coloured ones stay `1px`.

**Every artifact import is declared.** The host bundle imports Harness packages
at runtime, so anything `lib/index.js`, `client/client.cjs`, or
`agent/lib/main.mjs` imports must appear in an installing section of the root or
`agent/` manifest. `agent/` is a workspace, so its manifest is really read.

**Model-visible means logged.** The plugin contributes no system-prompt section
and no session event; the four `rw_*` tools and the routed tool results are
ordinary logged events. A new model-visible input would need a session event.

**Non-trivial changes carry an Agent Note** in `.agents/notes/<lifecycle>/`, in
both languages, and the format gate requires `## Problem` first plus
`## Decision`, `## Alternatives considered`, and `## Consequences`.

## What this repository owns

Three invariants have no counterpart in the Harness and must not be "fixed" by
delegating them away.

- **The daemon is a plain Node program.** It bundles everything it owns and
  imports only Node builtins, `node-pty`, and `vscode-jsonrpc`. `node-pty` is
  the one native module and stays external.
- **The anchor is a virtual mount.** A local anchor directory holds nothing but
  `.dsh-remote-worktree.json`; the files live on the machine, and `ctx.fs`
  routes any path under an anchor to that machine's daemon.
- **The host opens the SSH forward.** The plugin allocates a free local port and
  runs `ssh -N -L` to the daemon's loopback port. The local port is runtime
  state, never part of a machine's identity, and a dead forward must be reported
  rather than hidden.

## In-repo-only, does not apply

These Harness rules exist for `packages/*/*` inside the monorepo and have no
equivalent here. Do not chase them.

- The `@deepseek-ai/dsh-<name>` package naming and rescoping rules.
- `packages/AGENTS.md` naming rules that presuppose `rootDir: src`,
  `outDir: lib/types`, per-dependency project references, and registration in a
  tsconfig aggregate. This repository uses a shared `tsconfig.base.json` and
  three face configs, which is the out-of-tree equivalent.
- `packages/client/AGENTS.md` module-graph wiring: `PLATFORM_MODULES`,
  `dsh.client.external`, and the three `bundle/web-app` registration surfaces.
  This plugin instead declares peers and `dsh.client.inject`.
- `docs/testing.md` tiers: vitest, `test:coverage`, snapshots, and `test:web`.
  This repository runs `node --test --experimental-strip-types` over
  `tests/*.test.ts`, which is why test files are `.test.ts` rather than
  `.spec.ts`.
- `./invariant` publication; `README.md` records why none ships.
- The monorepo's CI gate inventory. This repository's single `ci.yml` is
  proportionate.

## Before committing

1. `npm run typecheck` — all three faces, zero errors.
2. `npm run build && npm run test:all` — in that order on a clean checkout.
3. `git status` — confirm every staged file is yours. This repository has been
   edited concurrently by more than one agent, and a commit once swept up
   another agent's uncommitted work under an unrelated message.
4. A behavior change updates the README and JSDoc it contradicts, in the same
   commit.
