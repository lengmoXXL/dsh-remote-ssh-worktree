/**
 * Route classification: decide which execution world a model- or
 * plugin-supplied path belongs to.
 *
 * Two spellings name the same remote file, and both occur in practice:
 *
 * - the **anchor** path — a real local directory the session's cwd and
 *   workspace point at, which is what the harness itself passes around;
 * - the **remote** path — the absolute path on the node, which is what the
 *   model sees once the prompt's cwd variable is overridden.
 *
 * A remote absolute path is only routable while exactly one live anchor claims
 * it as its remote root. Two nodes commonly share `/home/<user>/<repo>`, so an
 * ambiguous match is a typed failure rather than a silent pick: guessing would
 * read one machine and write another.
 *
 * @module dsh-remote-ssh-worktree/models/routing
 */

import { posix } from 'node:path'
import type { AnchorRoute } from '../storage/anchors.ts'
import { asNodeId } from '../storage/nodes.ts'
import type { NodeId } from '../storage/nodes.ts'

/** Where one path resolves to. */
export type Route =
  | { readonly kind: 'local' }
  | { readonly kind: 'remote'; readonly nodeId: NodeId; readonly remotePath: string }
  | {
    readonly kind: 'ambiguous'
    readonly remotePath: string
    /** The nodes whose remote root also claims `remotePath`, in discovery order. */
    readonly nodeIds: readonly NodeId[]
  }

/**
 * The explicit `node:<nodeId>:<path>` spelling. `nodeId` never contains a
 * colon, so the first one separates the id from an absolute POSIX path.
 */
const EXPLICIT = /^node:([^:/]+):(\/.*)$/s

/**
 * Whether `child` equals `parent` or lies below it, on whole path segments.
 *
 * A plain `startsWith` would match `/srv/app-old` against `/srv/app`.
 * @param parent - the canonical ancestor.
 * @param child - the canonical candidate.
 * @returns true when the candidate is the ancestor or one of its descendants.
 */
export function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true
  const root = parent.endsWith('/') ? parent : `${parent}/`
  return child.startsWith(root)
}

/**
 * Make a path absolute and remove `.` and `..` segments without touching the
 * filesystem. A relative path resolves against `cwd`, falling back to `/` so
 * classification always yields a definite answer.
 * @param input - the path as supplied.
 * @param cwd - the resolving base, typically the session cwd.
 * @returns a normalized absolute POSIX path.
 */
export function toAbsolute(input: string, cwd: string | undefined): string {
  // Windows separators reach classification when the host is Windows; remote
  // paths are always POSIX and the two never mix inside one comparison.
  const unified = input.replaceAll('\\', '/')
  if (unified.startsWith('/')) return posix.normalize(unified)
  return posix.normalize(posix.join(cwd === undefined ? '/' : cwd, unified))
}

/**
 * Classify one path against the live anchors.
 *
 * Precedence is: the explicit `node:<id>:<path>` spelling, then the anchor
 * prefix, then a remote root claimed by exactly one anchor, then the local
 * world. The anchor branch wins over the remote-root branch because it carries
 * the node id unambiguously.
 * @param input - the path as supplied by a tool call or another plugin.
 * @param cwd - the resolving base for a relative path.
 * @param anchors - every anchor this plugin currently owns.
 * @returns the route, including the `ambiguous` verdict this module exists for.
 */
export function classifyPath(
  input: string,
  cwd: string | undefined,
  anchors: readonly AnchorRoute[],
): Route {
  const explicit = EXPLICIT.exec(input)
  if (explicit !== null) {
    return { kind: 'remote', nodeId: asNodeId(explicit[1]!), remotePath: posix.normalize(explicit[2]!) }
  }

  const absolute = toAbsolute(input, cwd)

  for (const anchor of anchors) {
    if (isWithin(anchor.anchorPath, absolute)) {
      const suffix = absolute.slice(anchor.anchorPath.length)
      return { kind: 'remote', nodeId: anchor.nodeId, remotePath: posix.join(anchor.remoteRoot, suffix) }
    }
  }

  const claiming = anchors.filter(anchor => isWithin(anchor.remoteRoot, absolute))
  if (claiming.length === 1) {
    return { kind: 'remote', nodeId: claiming[0]!.nodeId, remotePath: absolute }
  }
  if (claiming.length > 1) {
    return {
      kind: 'ambiguous',
      remotePath: absolute,
      nodeIds: claiming.map(anchor => anchor.nodeId),
    }
  }

  return { kind: 'local' }
}
