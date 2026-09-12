/**
 * The anchor directory store.
 *
 * A remote worktree has no local directory of its own, but the harness gives a
 * session a local cwd, requires a workspace path to exist and to survive
 * `realpath`, and validates session membership against it. An anchor is the
 * answer: a real, empty local directory whose metadata names the remote
 * coordinates, so `ctx.fs` can route everything below it to the node while
 * every other subsystem keeps working on an ordinary local path.
 *
 * Layout, one directory per worktree:
 *
 * ```
 * <root>/<nodeId>/<repo base>/<name>/.dsh-remote-worktree.json
 * ```
 *
 * The directory is the identity; the metadata is the mapping. Removing the
 * metadata without the directory would leave a path that still routes, so both
 * move together.
 *
 * An anchor maps one remote directory, and there are two cases. A worktree
 * anchor maps the checkout `git worktree add` produced, and is what the
 * lifecycle cuts and removes. A directory anchor maps the repository directory
 * itself, which is what lets a machine's plain directory be opened as a
 * workspace before it is a git repository — and stay one after it becomes a
 * repository and worktrees are cut beside it.
 *
 * @module dsh-remote-ssh-worktree/storage/anchors
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AnchorId, NodeId } from '../ids.ts'

/** Metadata file name inside every anchor directory. */
export const ANCHOR_FILE = '.dsh-remote-worktree.json'

/** Metadata revision; a field change bumps it and refuses the old form. */
const DOCUMENT_VERSION = 1

/** Segment a directory anchor lives at, beside the worktrees of its repository. */
const DIRECTORY_SEGMENT = '.self'

/** What one anchor maps. */
export type AnchorKind = 'worktree' | 'directory'

/** Owner-only permissions: the file is bookkeeping, not a secret. */
const FILE_MODE = 0o600

/** How deep the loader walks below the anchor root: node / repo / name. */
const SCAN_DEPTH = 3

/** What every anchor carries, whichever directory it maps. */
interface AnchorBase {
  /** Stable generated id; the anchor path is the identity, this is a handle. */
  readonly anchorId: AnchorId
  /** The node the remote root lives on. */
  readonly nodeId: NodeId
  /**
   * Name of the directory this anchor was created for: the worktree's name, or
   * the repository's own name for a directory anchor.
   */
  readonly name: string
  /** Absolute local directory: the session cwd and workspace path. */
  readonly anchorPath: string
  /** Absolute POSIX directory on the node that this anchor maps onto. */
  readonly remoteRoot: string
  /** Absolute POSIX path of the repository the directory belongs to. */
  readonly repoPath: string
  /** ISO-8601 creation instant. */
  readonly createdAt: string
}

/** An anchor on the checkout a worktree was cut into. */
export interface WorktreeAnchor extends AnchorBase {
  readonly kind: 'worktree'
  /** Full branch name the checkout is on. */
  readonly branch: string
}

/** An anchor on the repository directory itself. */
export interface DirectoryAnchor extends AnchorBase {
  readonly kind: 'directory'
}

/** One remote directory's local handle. */
export type AnchorRecord = WorktreeAnchor | DirectoryAnchor

/**
 * The anchor facts a router routes by: which node, which local directory, and
 * which remote root — without the identity or branch the lifecycle needs.
 */
export interface AnchorRoute {
  /** The node the anchor's remote root lives on. */
  readonly nodeId: NodeId
  /** Absolute local directory used as the session cwd and workspace path. */
  readonly anchorPath: string
  /** Absolute POSIX root the anchor maps onto. */
  readonly remoteRoot: string
}

/** Fields a caller supplies when creating a worktree anchor. */
export interface WorktreeAnchorDraft {
  readonly kind: 'worktree'
  readonly nodeId: NodeId
  readonly name: string
  readonly repoPath: string
  readonly remoteRoot: string
  /** The branch the checkout is on, as the daemon reported it. */
  readonly branch: string
}

/** Fields a caller supplies when creating a directory anchor. */
export interface DirectoryAnchorDraft {
  readonly kind: 'directory'
  readonly nodeId: NodeId
  readonly name: string
  readonly repoPath: string
  /** The directory itself; a directory anchor maps one path onto itself. */
  readonly remoteRoot: string
}

/** Fields a caller supplies when creating an anchor. */
export type AnchorDraft = WorktreeAnchorDraft | DirectoryAnchorDraft

/** What the store needs from its owner. */
export interface AnchorStoreDeps {
  /** Absolute root every anchor directory is created below. */
  readonly root: string
  /** Injectable clock, so tests do not depend on wall time. */
  readonly now?: () => Date
}

/** The anchor store. */
export interface AnchorStore {
  /**
   * Discover every anchor below the root.
   * @returns the records in scan order.
   * @throws when a metadata file is malformed or carries an unsupported
   *   version — a stranded anchor must be visible, not silently dropped.
   */
  load(): Promise<readonly AnchorRecord[]>
  /** Every loaded anchor, in scan order. */
  list(): readonly AnchorRecord[]
  /**
   * One anchor by id.
   * @param anchorId - the generated handle.
   * @returns the record, or undefined when no anchor carries that id.
   */
  get(anchorId: AnchorId): AnchorRecord | undefined
  /**
   * Create the anchor directory and its metadata.
   * @param draft - the remote coordinates to record.
   * @returns the stored record.
   */
  create(draft: AnchorDraft): Promise<AnchorRecord>
  /**
   * Remove one anchor directory and its metadata.
   * @param anchorId - the generated handle.
   * @returns the removed record, or undefined when the id is unknown.
   */
  remove(anchorId: AnchorId): Promise<AnchorRecord | undefined>
  /** The routing table the filesystem consults. */
  routes(): readonly AnchorRoute[]
}

/** The metadata document written inside an anchor directory. */
interface AnchorDocument {
  readonly version: number
  readonly anchor: AnchorRecord
}

/** Every field a stored anchor may carry, as read from an untrusted document. */
type AnchorFields = Partial<Record<keyof WorktreeAnchor | keyof DirectoryAnchor, unknown>>

/** Whether an unknown value is a record this module wrote. */
function isAnchorRecord(value: unknown): value is AnchorRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as AnchorFields
  const kind = record.kind
  return typeof record.anchorId === 'string'
    && typeof record.nodeId === 'string'
    && (kind === undefined || kind === 'worktree' || kind === 'directory')
    && typeof record.name === 'string'
    && typeof record.anchorPath === 'string'
    && typeof record.remoteRoot === 'string'
    && typeof record.repoPath === 'string'
    // A worktree has a branch; a directory anchor and any document written
    // before kinds existed are the only ones allowed to omit it.
    && (typeof record.branch === 'string' || (record.branch === undefined && kind !== 'worktree'))
    && typeof record.createdAt === 'string'
}

/**
 * Parse one metadata document.
 * @param text - the file content.
 * @param file - the path, used only to name a failure.
 * @returns the record.
 * @throws when the JSON is malformed, the version is unsupported, or the
 *   record does not match the stored fields.
 */
function parseAnchor(text: string, file: string): AnchorRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON`, { cause: error })
  }
  const document = parsed as Partial<AnchorDocument>
  if (document.version !== DOCUMENT_VERSION) {
    throw new Error(`${file} has document version ${String(document.version)}; this build reads ${String(DOCUMENT_VERSION)}`)
  }
  if (!isAnchorRecord(document.anchor)) {
    throw new Error(`${file} carries an anchor this build does not understand`)
  }
  const anchor = document.anchor
  // A document written before kinds existed carries none, and the guard has
  // already refused any that omit the branch a worktree must have.
  if (anchor.kind === 'directory') return anchor
  return { ...anchor, kind: 'worktree' }
}

/** Read a directory's entries, treating absence as empty. */
async function readdirOrEmpty(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Walk the anchor tree and collect every metadata file it finds.
 *
 * Only directories are descended into, and a symlink is neither a directory
 * nor a metadata file here, so a link planted in the tree cannot make the scan
 * loop or escape the root.
 * @param dir - the directory to scan.
 * @param depth - levels still permitted below `dir`.
 * @returns the metadata file paths.
 */
async function findMetadataFiles(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return []
  const found: string[] = []
  for (const entry of await readdirOrEmpty(dir)) {
    const child = join(dir, entry.name)
    if (entry.isFile() && entry.name === ANCHOR_FILE) {
      found.push(child)
      continue
    }
    if (entry.isDirectory()) found.push(...await findMetadataFiles(child, depth - 1))
  }
  return found
}

/**
 * Build an anchor store over one root.
 * @param deps - the root and an optional clock.
 * @returns the store; call {@link AnchorStore.load} before serving reads.
 */
export function createAnchorStore(deps: AnchorStoreDeps): AnchorStore {
  const now = deps.now ?? (() => new Date())
  const root = resolve(deps.root)
  let anchors: AnchorRecord[] = []
  let loaded = false

  const requireLoaded = (): void => {
    if (!loaded) throw new Error('anchor store read before load()')
  }

  return {
    async load() {
      const files = (await findMetadataFiles(root, SCAN_DEPTH)).sort()
      anchors = []
      for (const file of files) {
        anchors.push(parseAnchor(await readFile(file, 'utf8'), file))
      }
      loaded = true
      return anchors
    },

    list() {
      requireLoaded()
      return anchors
    },

    get(anchorId) {
      requireLoaded()
      return anchors.find(anchor => anchor.anchorId === anchorId)
    },

    async create(draft) {
      requireLoaded()
      // A worktree anchor sits at its own name; a directory anchor sits beside
      // the worktrees at a segment no checkout can occupy, so the two kinds
      // never nest and the routers never see one path under two anchors.
      const anchorPath = join(
        root,
        draft.nodeId,
        basename(draft.repoPath),
        draft.kind === 'directory' ? DIRECTORY_SEGMENT : draft.name,
      )
      // Two records pointing at one directory would make removal ambiguous and
      // leave the survivor routing into a deleted path.
      if (anchors.some(anchor => anchor.anchorPath === anchorPath)) {
        throw new Error(`an anchor already owns ${anchorPath}`)
      }
      const shared = {
        anchorId: brandString<AnchorId>(randomUUID()),
        nodeId: draft.nodeId,
        name: draft.name,
        anchorPath,
        remoteRoot: draft.remoteRoot,
        repoPath: draft.repoPath,
        createdAt: now().toISOString(),
      }
      // `satisfies` on each arm keeps the discriminator narrow; an annotation
      // on the whole conditional would widen both into one unusable union.
      const record = draft.kind === 'worktree'
        ? { ...shared, kind: 'worktree', branch: draft.branch } satisfies WorktreeAnchor
        : { ...shared, kind: 'directory' } satisfies DirectoryAnchor
      await mkdir(anchorPath, { recursive: true })
      await writeFileAtomic(
        join(anchorPath, ANCHOR_FILE),
        `${JSON.stringify({ version: DOCUMENT_VERSION, anchor: record } satisfies AnchorDocument, null, 2)}\n`,
        { mode: FILE_MODE },
      )
      anchors = [...anchors, record]
      return record
    },

    async remove(anchorId) {
      requireLoaded()
      const record = anchors.find(anchor => anchor.anchorId === anchorId)
      if (record === undefined) return undefined
      await rm(record.anchorPath, { recursive: true, force: true })
      anchors = anchors.filter(anchor => anchor.anchorId !== anchorId)
      return record
    },

    routes() {
      requireLoaded()
      return anchors.map(anchor => ({
        nodeId: anchor.nodeId,
        anchorPath: anchor.anchorPath,
        remoteRoot: anchor.remoteRoot,
      }))
    },
  }
}
