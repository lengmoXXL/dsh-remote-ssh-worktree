/**
 * The remote worktree lifecycle.
 *
 * Every operation is two-sided on purpose: git runs on the node, and the local
 * anchor is created or dropped around it. The order matters in both
 * directions — an anchor is only recorded after the checkout exists, and the
 * checkout is only removed before its anchor, so a failure never leaves a
 * local path routing into nothing.
 *
 * A branch that could not be deleted is reported rather than swallowed: the
 * worktree is gone either way, and the operator needs to know the branch
 * outlived it.
 *
 * @module dsh-remote-ssh-worktree/worktree/manager
 */

import { posix } from 'node:path'
import type { WireMergeOutcome, WireRepoState, WireWorktree } from '../protocol.ts'
import type { AnchorDraft, AnchorRecord, AnchorStore } from '../anchors/store.ts'
import type { ChannelLookup, NodeChannel } from '../transport/contract.ts'
import { NodeRequestError } from '../transport/contract.ts'
import type { AnchorId, NodeId } from '../ids.ts'
import type { RepoRef } from '../repos/store.ts'

/** Directory, relative to the repository, that holds every managed checkout. */
const WORKTREE_ROOT = '.dsh-worktrees'

/** Directory holding the checkouts themselves. */
const WORKTREE_DIR = `${WORKTREE_ROOT}/worktree`

/** Prefix every managed branch carries. */
const BRANCH_PREFIX = 'worktree/'

/** What a caller supplies to cut a new worktree. */
export interface WorktreeDraft {
  /** The node whose repository is cut. */
  readonly nodeId: NodeId
  /** Absolute POSIX path of the repository on that node. */
  readonly repoPath: string
  /** Worktree name; the branch becomes `worktree/<name>`. */
  readonly name: string
  /** Revision to branch from; the repository's HEAD when omitted. */
  readonly baseRef?: string
}

/** What a removal did. */
export interface WorktreeRemoval {
  /** The anchor that was removed. */
  readonly anchor: AnchorRecord
  /** Whether the branch was deleted as well. */
  readonly branchDeleted: boolean
  /** Why the branch outlived the checkout, when it did. */
  readonly branchError?: string
}

/** One anchor joined with the live state of the node it points at. */
export interface WorktreeStatus {
  /** The local anchor. */
  readonly anchor: AnchorRecord
  /** The node's repository state, or undefined when the node is offline. */
  readonly repo?: WireRepoState
  /** Why the state is missing, when it is. */
  readonly error?: string
}

/** Best-effort workspace registration, so every caller behaves the same way. */
export interface WorkspaceHooks {
  /**
   * Record the anchor as a workspace.
   * @param anchor - the anchor just created.
   */
  register(anchor: AnchorRecord): Promise<void>
  /**
   * Drop the anchor's workspace registration.
   * @param anchor - the anchor just removed.
   */
  unregister(anchor: AnchorRecord): Promise<void>
}

/** What the manager needs from its owner. */
export interface WorktreeManagerDeps {
  /** The anchor store that owns local identity. */
  readonly anchors: AnchorStore
  /** Resolves the live channel for a node. */
  readonly channel: ChannelLookup
  /**
   * Workspace registration, when the deployment composes a registry. A failure
   * here never fails the git operation: the checkout and its anchor are durable
   * on their own, and the workspace entry is a convenience for opening it.
   */
  readonly workspace?: WorkspaceHooks
}

/** The worktree lifecycle. */
export interface WorktreeManager {
  /**
   * Cut a worktree on the node and record its anchor.
   * @param draft - node, repository, name, and optional base revision.
   * @returns the created anchor.
   * @throws the daemon's typed failure when git refuses; no anchor is recorded.
   */
  create(draft: WorktreeDraft): Promise<AnchorRecord>
  /** Every managed worktree with its node's live state, in anchor order. */
  list(): Promise<readonly WorktreeStatus[]>
  /**
   * The worktrees cut under one repository, read from local records alone.
   *
   * Answers a delete guard without contacting the machine, so the answer is
   * the same whether or not the node is reachable.
   * @param ref - the machine and repository path.
   * @returns the anchors cut under that repository, in anchor order.
   */
  anchorsIn(ref: RepoRef): readonly AnchorRecord[]
  /**
   * Remove one worktree: the checkout on the node, then its anchor.
   * @param anchorId - the anchor handle.
   * @param options - `force` discards uncommitted changes; `deleteBranch`
   *   also deletes the branch.
   * @returns what was removed, and whether the branch followed.
   * @throws the daemon's typed failure when git refuses; the anchor stays.
   */
  remove(anchorId: AnchorId, options: { force: boolean; deleteBranch: boolean }): Promise<WorktreeRemoval>
  /**
   * Merge one worktree's branch into its repository's current branch.
   * @param anchorId - the anchor handle.
   * @returns the merge outcome.
   * @throws the daemon's typed failure, including `GIT_DIRTY` for a conflicted
   *   merge, which the daemon aborts before answering.
   */
  bringBack(anchorId: AnchorId): Promise<WireMergeOutcome>
}

/** The remote path a managed checkout lives at. */
function remoteWorktreePath(repoPath: string, name: string): string {
  return posix.join(repoPath, WORKTREE_DIR, name)
}

/** The branch a managed checkout is created on. */
function branchFor(name: string): string {
  return `${BRANCH_PREFIX}${name}`
}

/**
 * Cut a worktree on the node and record its anchor.
 * @param deps - the manager's dependencies.
 * @param anchor - the anchor to register as a workspace.
 */
async function registerWorkspace(deps: WorktreeManagerDeps, anchor: AnchorRecord): Promise<void> {
  try {
    await deps.workspace?.register(anchor)
  } catch {
    // The checkout and its anchor are durable on disk; a workspace entry is a
    // convenience, so a registry failure must not undo the work.
  }
}

/**
 * Drop an anchor's workspace registration.
 * @param deps - the manager's dependencies.
 * @param anchor - the anchor that was removed.
 */
async function unregisterWorkspace(deps: WorktreeManagerDeps, anchor: AnchorRecord): Promise<void> {
  try {
    await deps.workspace?.unregister(anchor)
  } catch {
    // A stale registration is harmless; the workspace path no longer resolves.
  }
}

/**
 * Make the managed directory invisible to git.
 *
 * Without this the repository reports itself dirty the moment a worktree
 * exists, and `repoState.clean` — the fact every bring-back decision reads —
 * would be permanently false. The file is written after `git worktree add`
 * has created the parent directory, and a pre-existing file is left alone so a
 * user's own ignore rules survive.
 * @param channel - the live node channel.
 * @param repoPath - absolute POSIX path of the repository.
 */
async function ensureIgnored(channel: NodeChannel, repoPath: string): Promise<void> {
  try {
    await channel.request('fs.writeText', {
      path: posix.join(repoPath, WORKTREE_ROOT, '.gitignore'),
      content: '*\n',
      expected: { kind: 'createIfAbsent' },
    })
  } catch (error) {
    if (error instanceof NodeRequestError && error.data.code === 'FS_NOT_OBSERVED') return
    throw error
  }
}

/**
 * Build the worktree manager.
 * @param deps - the anchor store and the channel lookup.
 * @returns the lifecycle handle.
 */
export function createWorktreeManager(deps: WorktreeManagerDeps): WorktreeManager {
  /** The live channel for an anchor's node, or the typed offline failure. */
  const channelFor = (nodeId: NodeId) => {
    const channel = deps.channel(nodeId)
    if (channel === undefined) {
      throw new NodeRequestError({
        code: 'GIT_COMMAND_FAILED',
        message: `remote node "${nodeId}" is not connected`,
      })
    }
    return channel
  }

  const anchorById = (anchorId: AnchorId): AnchorRecord => {
    const anchor = deps.anchors.get(anchorId)
    if (anchor === undefined) throw new Error(`no anchor "${anchorId}"`)
    return anchor
  }

  return {
    async create(draft) {
      const channel = channelFor(draft.nodeId)
      const branch = branchFor(draft.name)
      const worktreePath = remoteWorktreePath(draft.repoPath, draft.name)
      const worktree: WireWorktree = await channel.request('git.worktreeAdd', {
        repoPath: draft.repoPath,
        worktreePath,
        branch,
        ...draft.baseRef === undefined ? {} : { baseRef: draft.baseRef },
      })

      // The add created the parent directory, so the ignore file can land now.
      await ensureIgnored(channel, draft.repoPath)

      const anchorDraft: AnchorDraft = {
        nodeId: draft.nodeId,
        name: draft.name,
        repoPath: draft.repoPath,
        // The daemon reports where the checkout actually landed, which is the
        // path every later call must use.
        remoteRoot: worktree.path,
        branch: worktree.branch ?? branch,
      }
      const anchor = await deps.anchors.create(anchorDraft)
      await registerWorkspace(deps, anchor)
      return anchor
    },

    async list() {
      const statuses: WorktreeStatus[] = []
      for (const anchor of deps.anchors.list()) {
        const channel = deps.channel(anchor.nodeId)
        if (channel === undefined) {
          statuses.push({ anchor, error: `node "${anchor.nodeId}" is not connected` })
          continue
        }
        try {
          statuses.push({ anchor, repo: await channel.request('git.repoState', { repoPath: anchor.repoPath }) })
        } catch (error) {
          statuses.push({ anchor, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return statuses
    },

    anchorsIn(ref) {
      return deps.anchors.list()
        .filter(anchor => anchor.nodeId === ref.nodeId && anchor.repoPath === ref.repoPath)
    },

    async remove(anchorId, options) {
      const anchor = anchorById(anchorId)
      const channel = channelFor(anchor.nodeId)

      await channel.request('git.worktreeRemove', {
        repoPath: anchor.repoPath,
        worktreePath: anchor.remoteRoot,
        force: options.force,
      })
      // The checkout is gone, so the local handle must go with it before any
      // optional step can fail.
      await deps.anchors.remove(anchorId)
      await unregisterWorkspace(deps, anchor)

      if (!options.deleteBranch) return { anchor, branchDeleted: false }
      try {
        await channel.request('git.branchDelete', {
          repoPath: anchor.repoPath,
          branch: anchor.branch,
          force: options.force,
        })
        return { anchor, branchDeleted: true }
      } catch (error) {
        return {
          anchor,
          branchDeleted: false,
          branchError: error instanceof Error ? error.message : String(error),
        }
      }
    },

    async bringBack(anchorId) {
      const anchor = anchorById(anchorId)
      return channelFor(anchor.nodeId).request('git.mergeBranch', {
        repoPath: anchor.repoPath,
        branch: anchor.branch,
      })
    },
  }
}

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
 * Build the display title a remote worktree gets as a local workspace.
 *
 * A workspace title is read by a person scanning a sidebar, so it names the
 * three things that distinguish one remote worktree from another — which
 * machine, which repository on it, and which checkout — and never the opaque
 * ids this plugin routes by. An unnamed repository falls back to its last path
 * segment, which is what a user would have called it; a path with no segment at
 * all falls back to the whole path so the label is never blank.
 * @param parts - the machine, repository, and worktree names.
 * @returns the composed title.
 */
export function worktreeLabel(parts: WorktreeLabelParts): string {
  const base = posix.basename(parts.repoPath)
  const repo = parts.repoName?.trim()
    || (base === '' || base === '/' ? parts.repoPath : base)
  return [parts.machine, repo, parts.name].join(SEPARATOR)
}
