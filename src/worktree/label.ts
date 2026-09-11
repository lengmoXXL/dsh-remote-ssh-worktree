/**
 * The display title a remote worktree gets as a local workspace.
 *
 * A workspace title is read by a person scanning a sidebar, so it names the
 * three things that distinguish one remote worktree from another — which
 * machine, which repository on it, and which checkout — and never the opaque
 * ids this plugin routes by.
 *
 * @module dsh-remote-worktree/worktree/label
 */

import { posix } from 'node:path'

/** What a worktree label is composed from. */
export interface WorktreeLabelParts {
  /** The machine's display title, falling back to its host. */
  readonly machine: string
  /** Absolute POSIX path of the repository on that machine. */
  readonly repoPath: string
  /** The repository's display name, when a record supplies one. */
  readonly repoName?: string | undefined
  /** The worktree name. */
  readonly name: string
}

/** Separator between the three parts. */
const SEPARATOR = ' · '

/**
 * Build the workspace title for one remote worktree.
 *
 * An unnamed repository falls back to its last path segment, which is what a
 * user would have called it; a path with no segment at all falls back to the
 * whole path so the label is never blank.
 * @param parts - the machine, repository, and worktree names.
 * @returns the composed title.
 */
export function worktreeLabel(parts: WorktreeLabelParts): string {
  const base = posix.basename(parts.repoPath)
  const repo = parts.repoName?.trim()
    || (base === '' || base === '/' ? parts.repoPath : base)
  return [parts.machine, repo, parts.name].join(SEPARATOR)
}
