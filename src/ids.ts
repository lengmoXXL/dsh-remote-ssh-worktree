/**
 * The opaque identifiers this plugin mints and routes by.
 *
 * A machine, a repository, and a worktree are all addressed by a generated
 * string, and the three travel together through the same management routes.
 * Branding them keeps one from being passed where another is expected, which
 * is a mistake the compiler catches and a reader does not: all three render as
 * the same text in a log or a URL.
 *
 * The brand is compile-time only. Validation happens where an untrusted string
 * first becomes one of these — the durable documents, the management routes,
 * and the tool arguments — and every later hop trusts the type.
 *
 * @module dsh-remote-worktree/ids
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** One configured machine. */
export type NodeId = Branded<'NodeId'>

/** One registered repository on a machine. */
export type RepoId = Branded<'RepoId'>

/** One worktree, addressed by its local anchor. */
export type AnchorId = Branded<'AnchorId'>

/**
 * Admit a string as a machine id.
 *
 * Called only where an untrusted string first becomes an id: a parsed document,
 * a route segment, or a tool argument. Every later hop carries the type.
 * @param value - the string the parser produced.
 * @returns the same string, branded.
 */
export function asNodeId(value: string): NodeId {
  return brandString<NodeId>(value)
}

/**
 * Admit a string as a repository id.
 * @param value - the string the parser produced.
 * @returns the same string, branded.
 */
export function asRepoId(value: string): RepoId {
  return brandString<RepoId>(value)
}

/**
 * Admit a string as a worktree anchor id.
 * @param value - the string the parser produced.
 * @returns the same string, branded.
 */
export function asAnchorId(value: string): AnchorId {
  return brandString<AnchorId>(value)
}
