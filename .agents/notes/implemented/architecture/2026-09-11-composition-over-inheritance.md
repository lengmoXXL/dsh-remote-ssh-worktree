# Agent Note: Remote worktrees by composition, not inheritance

Status: implemented

English | [中文](2026-09-11-composition-over-inheritance.zh.md)

## Problem

The Harness gives a session exactly one filesystem, one subprocess runtime, and
one shell. Running a session's tools on another machine means replacing those
three seams, and the obvious way to do it is to subclass the shipped
implementations and override the methods that need to cross the network.

That way charges rent on every future change to the shipped classes. A
protected field renamed upstream, a constructor that grows a required argument,
or a new method that the subclass silently fails to override all become this
plugin's problem, and the plugin keeps paying for the rest of the base class it
never uses. The seams are also `Service` subclasses, whose `protected` members
make the types nominal, so an inheriting implementation cannot be swapped for a
plain object even where that would be correct.

Isolation had a second question: what is a "remote world", and what identifies
it? Copying the repository to the machine would make the identity a path on
another host and leave the user's checkout untouched; cutting a `git worktree`
per task gives each task its own branch, and a merge back is an ordinary local
git operation rather than a file transfer.

## Decision

**Seams are composed, never inherited.** Each of the three seams is registered
with `ctx.provide` — the primitive Cordis' own `Service` constructor calls — and
each value is a plain object that delegates to a shipped implementation
composed in an isolated scope (`ctx.isolate(name)` + `ctx.plugin(Factory)`).
Nothing in this package extends a Harness class. A path that belongs to no
anchor classifies as local and is delegated unchanged, so a deployment with no
machine configured behaves exactly like the stock composition.

**The remote world is an anchor plus a worktree.** A machine holds repositories;
a repository holds worktrees. Cutting one creates a real directory on the
machine under `.dsh-worktrees/worktree/<name>` on branch `worktree/<name>`, and
a local anchor directory that holds nothing but a metadata file. The anchor is
the identity every tool sees; the machine path is what the daemon serves.

**The daemon depends on nothing.** It is a plain Node program that imports
neither Cordis nor any `@deepseek-ai/*` package, so it cannot drift with the
Harness, and it is bundled to one file per build.

**The host opens the forward.** A machine's daemon binds its own loopback. The
host picks a free local port and forwards it over the operator's own `ssh`, so
`~/.ssh/config`, `ssh-agent`, `ProxyJump`, and bastion hosts work as they
already do, and the local port is never part of a machine's identity.

## Alternatives considered

**Subclassing the shipped seams.** Rejected: it charges rent on every upstream
change to a class this plugin uses a fraction of, and the seams are `Service`
subclasses whose `protected` members are nominal, so an inheriting
implementation could not be swapped for a plain object where that is correct.

**Copying the repository to the machine per task.** Rejected: the task's
identity would become a path on another host, the user's checkout would not be
the thing being edited, and bringing work back would be a file transfer rather
than the local git operation the operator already knows.

**Binding the daemon to a reachable interface instead of forwarding.** Rejected:
the daemon grants shell access as the user that runs it and carries no TLS, so
exposing it is a deliberate unsafe choice. Forwarding over the operator's own
`ssh` reuses trust they already configured, and keeps the daemon on loopback.

**Installing the daemon with `npm install` on the machine.** Rejected for now:
it requires npm and outbound network on the machine, where uploading the single
bundled file needs only `node`. Revisit when the daemon is rewritten.

## Consequences

- A change to a shipped seam implementation cannot break this plugin unless the
  seam's public contract changes, and then both are fixed at the seam.
- The routers must re-declare the sandbox mode they delegate, because the base
  refuses to compose a mount that claims not to confine. Reporting `undefined`
  made the plugin uncomposable in a real profile; the regression is pinned.
- Two durable stores own their commit point: the node and repository documents
  are written before the in-memory list is replaced, so a save that throws
  cannot leave a record the caller was told had failed.
- The browser half ships as one dynamic CommonJS bundle with no stylesheet
  channel, so its CSS Module is compiled into the artifact and attaches one
  tagged `<style>` on evaluation rather than being emitted as a file.
- `direct` remains a stored transport solely so a document written before the
  SSH transport keeps loading; nothing creates one.
