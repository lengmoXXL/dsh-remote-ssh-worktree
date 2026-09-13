/**
 * The remote worktree lifecycle: create, list, open, close, remove.
 *
 * It also owns the one workspace that is not a worktree: a repository directory
 * opened as itself. A machine's directory can be worked in before it is a git
 * repository, so opening it maps the directory onto its own anchor, and cutting
 * worktrees from it becomes possible later without re-registering anything —
 * whether it is a repository is a live fact, asked of the machine each time the
 * section reads it.
 *
 * The same lifecycle runs for the local machine, and it is the same to every
 * caller: the same rows, the same drafts, the same results. What differs is
 * where the truth lives. A machine reached over SSH needs an anchor — a local
 * directory standing in for a path this host cannot reach — and that anchor is
 * the record. This host needs nothing of the kind: its checkouts are real
 * directories here, so git itself is the record and an id names a path rather
 * than a handle. That is why a local worktree has no entry to create and none
 * to drop, and why forgetting a repository is still refused while git lists
 * checkouts under it: those rows would be stranded in the panel.
 *
 * Every operation is two-sided on purpose: git runs on the node, and the local
 * anchor is created or dropped around it. The order matters in both
 * directions — an anchor is only recorded after the checkout exists, and the
 * checkout is only removed before its anchor, so a failure never leaves a
 * local path routing into nothing. Within teardown the workspace entry goes
 * first, because dropping the anchor takes the directory that resolves it.
 *
 * Creating one also records the repository it was cut from. That is not
 * bookkeeping for its own sake: the surfaces group worktrees by repository, so
 * a worktree whose repository has no record is a worktree nobody can see or
 * remove from the settings section.
 *
 * The branch is out of scope. Creating a worktree creates the branch it needs,
 * that is unavoidable; deleting one leaves the branch behind unless the caller
 * explicitly asks for it, because deleting branches belongs to whatever plugin
 * owns branches. A branch that could not be deleted is reported rather than
 * swallowed: the worktree is gone either way, and the operator needs to know
 * the branch outlived it.
 *
 * @module dsh-workspace/models/worktrees
 */

import { writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { WireWorktree } from '../remote/protocol.ts'
import type { AnchorRecord, AnchorStore, DirectoryAnchor, WorktreeAnchor } from '../storage/anchors.ts'
import type { RepoRecord, RepoStore } from '../storage/repos.ts'
import type { ChannelLookup, NodeChannel } from '../remote/client.ts'
import { NodeRequestError } from '../remote/client.ts'
import type { AnchorId } from '../storage/anchors.ts'
import { asAnchorId } from '../storage/anchors.ts'
import type { NodeId } from '../storage/nodes.ts'
import type { RepoRef } from '../storage/repos.ts'
import {
  addWorktree,
  deleteBranch,
  isRepository,
  listWorktrees,
  removeWorktree,
} from '../local/git.ts'
import { localPathType, resolveLocalPath } from '../local/fs.ts'

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
  /** The worktree anchor that was removed. */
  readonly anchor: WorktreeAnchor
  /** Whether the branch was deleted as well. */
  readonly branchDeleted: boolean
  /** Why the branch outlived the checkout, when it did. */
  readonly branchError?: string
}

/** One anchor with what this host can say about it without asking the node. */
export interface WorktreeStatus {
  /** The local anchor. */
  readonly anchor: AnchorRecord
  /** Whether the anchor is registered as a workspace, so a session can open on it. */
  readonly open: boolean
  /** Why the worktree cannot be used right now, when it cannot. */
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
  /**
   * Whether the anchor currently holds a workspace registration.
   * @param anchor - the anchor to ask about.
   */
  registered(anchor: AnchorRecord): Promise<boolean>
}

/** What the manager needs from its owner. */
export interface WorktreeManagerDeps {
  /** The anchor store that owns local identity. */
  readonly anchors: AnchorStore
  /**
   * The repository records. Cutting a worktree records the repository it came
   * from, because every surface groups worktrees by repository and a worktree
   * whose repository is missing is one nobody can see.
   */
  readonly repos: RepoStore
  /** Resolves the live channel for a node. */
  readonly channel: ChannelLookup
  /**
   * Whether one node id names this host rather than another machine.
   *
   * A local node reaches its own filesystem, so it takes the branch that reads
   * paths and runs git here instead of the branch that talks to a daemon. The
   * answer comes from the registry rather than from the channel lookup, because
   * "not connected" and "this host" are different states and only one of them
   * is a failure.
   */
  readonly isLocalNode: (nodeId: NodeId) => boolean
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
   * @returns the created worktree anchor.
   * @throws the daemon's typed failure when git refuses; no anchor is recorded.
   */
  create(draft: WorktreeDraft): Promise<WorktreeAnchor>
  /** Every managed worktree with its node's live state, in anchor order. */
  list(): Promise<readonly WorktreeStatus[]>
  /**
   * The worktrees cut under one repository.
   *
   * Answers the delete guard. For a machine it reads local records alone, so
   * the answer is the same whether or not the node is reachable; for this host
   * it asks git, because that is where a local checkout is recorded.
   * @param ref - the machine and repository path.
   * @returns the worktrees under that repository, in listing order.
   */
  anchorsIn(ref: RepoRef): Promise<readonly AnchorRecord[]>
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
   * Register the anchor as a workspace again, so it can be opened.
   *
   * Unlike creation, this is an explicit ask: a registry that is missing or
   * refuses fails the call rather than being swallowed.
   * @param anchorId - the anchor handle.
   * @returns the anchor that is now open.
   * @throws when no such anchor exists, or the workspace registry refuses.
   */
  open(anchorId: AnchorId): Promise<AnchorRecord>
  /**
   * Drop the anchor's workspace registration, leaving the machine untouched.
   * @param anchorId - the anchor handle.
   * @returns the anchor that is now closed.
   * @throws when no such anchor exists.
   */
  close(anchorId: AnchorId): Promise<AnchorRecord>
  /**
   * Open a repository directory as a workspace in its own right.
   *
   * Git is not consulted: a directory that is not a repository yet can still be
   * worked in, and the anchors of the worktrees cut from it later sit beside
   * this one. Idempotent — opening an open directory registers it again instead
   * of creating a second anchor.
   * @param ref - the machine and the directory's path on it.
   * @returns the directory anchor that is now open.
   * @throws when the machine is unreachable or no workspace registry is composed.
   */
  openDirectory(ref: RepoRef): Promise<DirectoryAnchor>
  /**
   * Close a repository directory's workspace and drop its anchor.
   *
   * Nothing on the machine is touched: the anchor is this host's bookkeeping,
   * so closing the workspace is what removes it.
   * @param ref - the machine and the directory's path on it.
   * @returns the anchor that was dropped, or undefined when none was open.
   */
  closeDirectory(ref: RepoRef): Promise<DirectoryAnchor | undefined>
}

/** The remote path a managed checkout lives at. */
/** The path a managed checkout is created at, on whichever machine owns it. */
function managedWorktreePath(repoPath: string, name: string): string {
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
async function registerWorkspace(deps: WorktreeManagerDeps, anchor: AnchorRecord): Promise<void> {  try {
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
 * exists, and `repoState.clean` — the fact the removal guard reads —
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
 * Prefix that marks an id as naming a path on this host.
 *
 * A machine's ids come from the anchor store and are generated once. This host
 * has no such store, so its ids are derived from what they name and stay opaque
 * to every caller: nothing outside this module reads more than this prefix.
 */
const LOCAL_ID_PREFIX = 'local:'

/** The id one local path is addressed by. */
function localAnchorId(kind: 'worktree' | 'directory', path: string, repoPath: string): AnchorId {
  const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')
  return asAnchorId(kind === 'directory'
    ? `${LOCAL_ID_PREFIX}directory:${encoded(path)}`
    : `${LOCAL_ID_PREFIX}worktree:${encoded(path)}:${encoded(repoPath)}`)
}

/** The row a local repository itself is opened through. */
function localDirectoryAnchor(record: RepoRecord): DirectoryAnchor {
  const name = posix.basename(record.repoPath) || record.repoPath
  return {
    anchorId: localAnchorId('directory', record.repoPath, record.repoPath),
    nodeId: record.nodeId,
    kind: 'directory',
    name,
    repoPath: record.repoPath,
    // A local directory maps onto itself: the checkout and the workspace path
    // are the same path, which is what makes routing unnecessary here.
    anchorPath: record.repoPath,
    remoteRoot: record.repoPath,
    createdAt: record.createdAt,
  }
}

/**
 * Every checkout and repository directory this host manages.
 *
 * A machine's rows come from its anchors. This host has none, so they come from
 * git, which is where a local checkout actually lives — including one cut by
 * hand, outside the panel, which is then just as visible and openable as the
 * ones the panel made. The repository's own worktree is the row that opens the
 * repository directory itself.
 * @param deps - the manager's dependencies.
 * @returns the rows, the local repository records in their stored order.
 */
async function localStatuses(deps: WorktreeManagerDeps): Promise<readonly WorktreeStatus[]> {
  const statuses: WorktreeStatus[] = []
  for (const repo of deps.repos.list()) {
    if (!deps.isLocalNode(repo.nodeId)) continue
    const directory = localDirectoryAnchor(repo)
    statuses.push({ anchor: directory, open: await deps.workspace?.registered(directory) ?? false })
    // A directory that is not a repository yet is a legitimate record: it can be
    // opened as a workspace and initialized later, so git is asked every time.
    if (!await isRepository(repo.repoPath).catch(() => false)) continue
    const checkouts = await listWorktrees(repo.repoPath).catch(() => [])
    for (const checkout of checkouts.slice(1)) {
      // A checkout whose directory is gone is git's own leftover rather than a
      // row: nothing can be opened or removed through it.
      if (await localPathType(checkout.path) !== 'directory') continue
      const anchor: WorktreeAnchor = {
        anchorId: localAnchorId('worktree', checkout.path, repo.repoPath),
        nodeId: repo.nodeId,
        kind: 'worktree',
        name: posix.basename(checkout.path) || checkout.path,
        repoPath: repo.repoPath,
        anchorPath: checkout.path,
        remoteRoot: checkout.path,
        // A detached checkout has no branch to name, and an empty one is what
        // every surface already renders as silence.
        branch: checkout.branch ?? '',
        createdAt: repo.createdAt,
      }
      statuses.push({ anchor, open: await deps.workspace?.registered(anchor) ?? false })
    }
  }
  return statuses
}

/** One local row by the id a caller holds, or undefined when none carries it. */
async function localEntry(
  deps: WorktreeManagerDeps,
  anchorId: AnchorId,
): Promise<AnchorRecord | undefined> {
  const statuses = await localStatuses(deps)
  return statuses.find(status => status.anchor.anchorId === anchorId)?.anchor
}

/**
 * Cut a worktree on this host and register its checkout.
 * @param deps - the manager's dependencies.
 * @param draft - node, repository, name, and optional base revision.
 * @returns the created checkout's record.
 */
async function createLocalWorktree(deps: WorktreeManagerDeps, draft: WorktreeDraft): Promise<WorktreeAnchor> {
  // One spelling of the repository, settled before anything is written: it is
  // what the checkout, the record, and the panel's tree carry, so a later
  // lookup by path finds the same directory the caller meant.
  const repoPath = await resolveLocalPath(draft.repoPath)
  if (!await isRepository(repoPath)) {
    throw new Error(`"${repoPath}" is not a git repository on this machine`)
  }
  const branch = branchFor(draft.name)
  const worktreePath = managedWorktreePath(repoPath, draft.name)
  await addWorktree({
    repoPath,
    worktreePath,
    branch,
    ...draft.baseRef === undefined ? {} : { baseRef: draft.baseRef },
  })
  // The add created the parent directory, so the ignore file can land now.
  await ensureIgnoredLocally(repoPath)

  const anchor: WorktreeAnchor = {
    anchorId: localAnchorId('worktree', worktreePath, repoPath),
    nodeId: draft.nodeId,
    kind: 'worktree',
    name: draft.name,
    repoPath,
    anchorPath: worktreePath,
    remoteRoot: worktreePath,
    branch,
    createdAt: new Date().toISOString(),
  }
  // Known repositories keep the name a person gave them; a worktree is only
  // ever what registers a repository nobody has registered yet.
  if (deps.repos.find({ nodeId: draft.nodeId, repoPath }) === undefined) {
    await deps.repos.upsert({ nodeId: draft.nodeId, repoPath })
  }
  await registerWorkspace(deps, anchor)
  return anchor
}

/**
 * Remove one checkout on this host, leaving its branch.
 * @param deps - the manager's dependencies.
 * @param anchor - the checkout's record.
 * @param options - `force` discards uncommitted changes; `deleteBranch` also
 *   deletes the branch.
 * @returns what was removed, and whether the branch followed.
 */
async function removeLocalWorktree(
  deps: WorktreeManagerDeps,
  anchor: WorktreeAnchor,
  options: { force: boolean; deleteBranch: boolean },
): Promise<WorktreeRemoval> {
  await removeWorktree({
    repoPath: anchor.repoPath,
    worktreePath: anchor.anchorPath,
    force: options.force,
  })
  // The workspace entry resolves by path, so it goes before the path stops
  // existing under its feet.
  await unregisterWorkspace(deps, anchor)
  if (!options.deleteBranch) return { anchor, branchDeleted: false }
  try {
    await deleteBranch({ repoPath: anchor.repoPath, branch: anchor.branch, force: options.force })
    return { anchor, branchDeleted: true }
  } catch (error) {
    return {
      anchor,
      branchDeleted: false,
      branchError: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Make the managed directory invisible to git, on this host.
 *
 * The same file the remote path writes, for the same reason: without it the
 * repository reports itself dirty the moment a worktree exists. It is written
 * after `git worktree add` has created the parent directory, and a pre-existing
 * file is left alone so a user's own ignore rules survive.
 * @param repoPath - absolute path of the repository.
 */
async function ensureIgnoredLocally(repoPath: string): Promise<void> {
  try {
    await writeFile(posix.join(repoPath, WORKTREE_ROOT, '.gitignore'), '*\n', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Register one path as a workspace, so a session can be opened on it.
 *
 * Unlike creation, this is an explicit ask: a registry that is missing or
 * refuses fails the call rather than being swallowed.
 * @param deps - the manager's dependencies.
 * @param anchor - the worktree or directory to open.
 * @returns the anchor that is now open.
 * @throws when the deployment composes no workspace registry, or it refuses.
 */
async function openAsWorkspace<T extends AnchorRecord>(
  deps: WorktreeManagerDeps,
  anchor: T,
): Promise<T> {
  const workspace = deps.workspace
  if (workspace === undefined) {
    throw new Error('this deployment composes no workspace registry, so a worktree cannot be opened')
  }
  await workspace.register(anchor)
  return anchor
}

/**
 * Build the worktree manager.
 * @param deps - the anchor store, the repository records, and the node lookups.
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
      if (deps.isLocalNode(draft.nodeId)) return await createLocalWorktree(deps, draft)
      const channel = channelFor(draft.nodeId)
      // One spelling of the repository, settled before anything is written: it
      // is what the worktree path, the anchor, and the repository record carry,
      // so a later lookup by path — the removal guard, the section's tree —
      // finds the same directory the caller meant.
      const { canonicalPath: repoPath } = await channel.request('fs.resolve', { path: draft.repoPath })
      const branch = branchFor(draft.name)
      const worktreePath = managedWorktreePath(repoPath, draft.name)
      const worktree: WireWorktree = await channel.request('git.worktreeAdd', {
        repoPath,
        worktreePath,
        branch,
        ...draft.baseRef === undefined ? {} : { baseRef: draft.baseRef },
      })

      // The add created the parent directory, so the ignore file can land now.
      await ensureIgnored(channel, repoPath)

      // The daemon reports where the checkout actually landed and which branch
      // it settled on, which are the facts every later call must use.
      const checkedOut = worktree.branch ?? branch
      const anchor = await deps.anchors.create({
        kind: 'worktree',
        nodeId: draft.nodeId,
        name: draft.name,
        repoPath,
        remoteRoot: worktree.path,
        branch: checkedOut,
      })
      // Known repositories keep the name a person gave them; a worktree is
      // only ever what registers a repository nobody has registered yet.
      if (deps.repos.find({ nodeId: draft.nodeId, repoPath }) === undefined) {
        await deps.repos.upsert({ nodeId: draft.nodeId, repoPath })
      }
      await registerWorkspace(deps, anchor)
      return { ...anchor, kind: 'worktree', branch: checkedOut }
    },

    async list() {
      // The local machine leads the list, as it leads the machine list: its
      // rows are read here rather than asked of anything.
      const statuses: WorktreeStatus[] = [...await localStatuses(deps)]
      for (const anchor of deps.anchors.list()) {
        const open = await deps.workspace?.registered(anchor) ?? false
        // Listing is a local read. The branch a checkout sits on and whether it
        // is dirty belong to the machine's own git, so the only thing worth
        // reporting here is whether the worktree can be reached at all.
        statuses.push(deps.channel(anchor.nodeId) === undefined
          ? { anchor, open, error: `node "${anchor.nodeId}" is not connected` }
          : { anchor, open })
      }
      return statuses
    },

    async anchorsIn(ref) {
      if (deps.isLocalNode(ref.nodeId)) {
        return (await localStatuses(deps))
          .filter(status => status.anchor.repoPath === ref.repoPath)
          .map(status => status.anchor)
      }
      return deps.anchors.list()
        .filter(anchor => anchor.nodeId === ref.nodeId && anchor.repoPath === ref.repoPath)
    },

    async remove(anchorId, options) {
      if (anchorId.startsWith(LOCAL_ID_PREFIX)) {
        const anchor = await localEntry(deps, anchorId)
        if (anchor === undefined) throw new Error(`no worktree "${anchorId}" on this machine`)
        // `git worktree remove` on the repository directory would delete the
        // person's own checkout, so only a worktree can be removed. A directory
        // is closed instead, which touches nothing on the machine.
        if (anchor.kind !== 'worktree') {
          throw new Error(`"${anchor.name}" is the repository directory, not a worktree; close it instead`)
        }
        return await removeLocalWorktree(deps, anchor, options)
      }
      const anchor = anchorById(anchorId)
      // `git worktree remove` on the repository directory would delete the
      // person's own checkout, so only a worktree can be removed. A directory
      // anchor is closed instead, which touches nothing on the machine.
      if (anchor.kind !== 'worktree') {
        throw new Error(`"${anchor.name}" is the repository directory, not a worktree; close it instead`)
      }
      const channel = channelFor(anchor.nodeId)

      await channel.request('git.worktreeRemove', {
        repoPath: anchor.repoPath,
        worktreePath: anchor.remoteRoot,
        force: options.force,
      })
      // The checkout is gone, so the local handle must go with it — but the
      // workspace registry resolves an entry by path, which stops resolving the
      // moment the anchor directory is removed, so that goes first.
      await unregisterWorkspace(deps, anchor)
      await deps.anchors.remove(anchorId)

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

    async open(anchorId) {
      const anchor = anchorId.startsWith(LOCAL_ID_PREFIX)
        ? await localEntry(deps, anchorId)
        : anchorById(anchorId)
      if (anchor === undefined) throw new Error(`no worktree "${anchorId}" on this machine`)
      return await openAsWorkspace(deps, anchor)
    },

    async close(anchorId) {
      const anchor = anchorId.startsWith(LOCAL_ID_PREFIX)
        ? await localEntry(deps, anchorId)
        : anchorById(anchorId)
      if (anchor === undefined) throw new Error(`no worktree "${anchorId}" on this machine`)
      await deps.workspace?.unregister(anchor)
      return anchor
    },

    async openDirectory(ref) {
      const workspace = deps.workspace
      if (workspace === undefined) {
        throw new Error('this deployment composes no workspace registry, so a directory cannot be opened')
      }
      if (deps.isLocalNode(ref.nodeId)) {
        const record = deps.repos.find(ref)
        if (record === undefined) throw new Error(`no repository record for "${ref.repoPath}"`)
        return await openAsWorkspace(deps, localDirectoryAnchor(record))
      }
      const directoryAnchor = () => deps.anchors.list().find(
        (anchor): anchor is DirectoryAnchor =>
          anchor.kind === 'directory' && anchor.nodeId === ref.nodeId && anchor.repoPath === ref.repoPath,
      )
      const existing = directoryAnchor()
      if (existing !== undefined) {
        await workspace.register(existing)
        return existing
      }

      const channel = channelFor(ref.nodeId)
      const { canonicalPath: repoPath } = await channel.request('fs.resolve', { path: ref.repoPath })
      const anchor = await deps.anchors.create({
        kind: 'directory',
        nodeId: ref.nodeId,
        name: posix.basename(repoPath) || repoPath,
        repoPath,
        // A directory anchor maps the directory onto itself: there is no
        // checkout to distinguish, so the two spellings are one path.
        remoteRoot: repoPath,
      })
      try {
        await workspace.register(anchor)
      } catch (error) {
        // An anchor with no workspace is a path that routes into a directory
        // nobody asked to open, so the attempt leaves nothing behind.
        await deps.anchors.remove(anchor.anchorId)
        throw error
      }
      return { ...anchor, kind: 'directory' }
    },

    async closeDirectory(ref) {
      if (deps.isLocalNode(ref.nodeId)) {
        const record = deps.repos.find(ref)
        if (record === undefined) return undefined
        const anchor = localDirectoryAnchor(record)
        // Closing is the registration going away; a local directory has no
        // record of its own to drop, so an unregistered one is already closed.
        const open = await deps.workspace?.registered(anchor) ?? false
        if (!open) return undefined
        await unregisterWorkspace(deps, anchor)
        return anchor
      }
      const anchor = deps.anchors.list().find(
        (entry): entry is DirectoryAnchor =>
          entry.kind === 'directory' && entry.nodeId === ref.nodeId && entry.repoPath === ref.repoPath,
      )
      if (anchor === undefined) return undefined
      // The registration resolves by path, which stops resolving once the
      // anchor directory is gone, so it goes first.
      await unregisterWorkspace(deps, anchor)
      await deps.anchors.remove(anchor.anchorId)
      return anchor
    },
  }
}

/** What a workspace label is composed from. */
export interface WorkspaceLabelParts {
  /** The machine's display title, falling back to its host. */
  readonly machine: string
  /** Absolute POSIX path of the repository on that machine. */
  readonly repoPath: string
  /** The repository's display name, when a record supplies one. */
  readonly repoName?: string | undefined
  /** The checkout's name; absent when the workspace is the directory itself. */
  readonly name?: string | undefined
}

/** Separator between the three parts. */
const SEPARATOR = ' · '

/**
 * Build the display title a remote directory gets as a local workspace.
 *
 * A workspace title is read by a person scanning a sidebar, so it names the
 * things that distinguish one from another — which checkout, which repository,
 * and which machine — and never the opaque ids this plugin routes by. The
 * checkout leads because it is what the person chose and what they are looking
 * for; the machine trails because it is the context they already know. A
 * directory opened as itself has no checkout to name, so its title begins at
 * the repository. An unnamed repository falls back to its last path segment,
 * which is what a user would have called it; a path with no segment at all
 * falls back to the whole path so the label is never blank.
 * @param parts - the machine, repository, and checkout names.
 * @returns the composed title.
 */
export function workspaceLabel(parts: WorkspaceLabelParts): string {
  const base = posix.basename(parts.repoPath)
  const repo = parts.repoName?.trim()
    || (base === '' || base === '/' ? parts.repoPath : base)
  const segments = parts.name === undefined ? [repo, parts.machine] : [parts.name, repo, parts.machine]
  return segments.join(SEPARATOR)
}
