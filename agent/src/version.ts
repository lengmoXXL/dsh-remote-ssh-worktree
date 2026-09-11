/**
 * Opaque version tokens for guarded writes.
 *
 * A token is the whole freshness fact the plugin holds: it compares the token
 * a read returned with the one the daemon reports immediately before a guarded
 * write, so a write staged against stale content is rejected instead of
 * overwriting someone else's work.
 *
 * That check-then-write window is not atomic. The comparison and the `rename`
 * that publishes new content are two separate filesystem operations, and a
 * concurrent writer can land between them — a per-target in-process lock would
 * only serialize this daemon's own connections, not the editors, build tools,
 * and shells that share the machine. The window is accepted because the token
 * is advisory: losing the race costs one rejected write and a re-read, never
 * silent corruption, since every daemon write still publishes one complete
 * file through a single rename.
 *
 * @module dsh-remote-agent/version
 */

import type { BigIntStats } from 'node:fs'

/**
 * Derive a target's token from its metadata.
 * @param info - bigint metadata read with `stat` or `lstat`.
 * @returns an opaque `mtimeMs:size:ino` token, comparable only for equality.
 */
export function versionOf(info: BigIntStats): string {
  return `${info.mtimeMs}:${info.size}:${info.ino}`
}

/**
 * Token for a target that disappeared between publication and the post-write
 * probe. It compares equal to no live target's {@link versionOf} result, so a
 * consumer holding it fails its next guarded write as stale.
 * @param path - the canonical path that is no longer present.
 * @returns the substitute token.
 */
export function missingVersion(path: string): string {
  return `missing:${path}`
}
