/**
 * The durable record of the git repositories a user has registered on their
 * machines.
 *
 * A repository is the middle layer of the management tree: a machine holds
 * repositories, and a repository holds the worktrees cut from it. The record
 * stores only what a user chose — which machine, which path, what to call it —
 * because branch and cleanliness are live facts read from the daemon on every
 * listing and would be stale the moment they were written down.
 *
 * The document lives beside the node registry under the harness home and is
 * replaced atomically under a cross-process lock, so two harness processes
 * never interleave a read-render-commit cycle.
 *
 * @module dsh-remote-worktree/repos/store
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { NodeId, RepoId } from '../ids.ts'

/** Document revision; a shape change bumps it and refuses the old form. */
const DOCUMENT_VERSION = 1

/** Owner-only permissions: the document names paths on other machines. */
const FILE_MODE = 0o600

/** One registered repository. */
export interface RepoRecord {
  /** Stable generated id; never the path, so moving a checkout is free. */
  readonly repoId: RepoId
  /** The machine holding the checkout. */
  readonly nodeId: NodeId
  /** Absolute POSIX path of the repository on that machine. */
  readonly repoPath: string
  /** Display name. Defaults to the path's last segment. */
  readonly name: string
  /** ISO-8601 creation instant. */
  readonly createdAt: string
}

/** A caller's registration request. */
export interface RepoDraft {
  /** Existing id to update in place; omitted registers a new repository. */
  readonly repoId?: RepoId
  /** The machine holding the checkout. */
  readonly nodeId: NodeId
  /** Absolute POSIX path of the repository on that machine. */
  readonly repoPath: string
  /** Display name; omitted derives one from the path. */
  readonly name?: string
}

/** Where one repository lives, as callers address it. */
export type RepoRef = Pick<RepoRecord, 'nodeId' | 'repoPath'>

/** The repository store. */
export interface RepoStore {
  /**
   * Read the document into memory.
   * @returns the loaded records, in document order.
   * @throws when the JSON is malformed, the version is unsupported, or a
   *   record is not one this build wrote.
   */
  load(): Promise<readonly RepoRecord[]>
  /** Every registered repository, in stable document order. */
  list(): readonly RepoRecord[]
  /**
   * One repository by id.
   * @param repoId - the generated record id.
   * @returns the record, or undefined when no repository carries that id.
   */
  get(repoId: RepoId): RepoRecord | undefined
  /**
   * The record already covering one machine path.
   * @param ref - the machine and absolute path.
   * @returns the record, or undefined when that path is not registered.
   */
  find(ref: RepoRef): RepoRecord | undefined
  /**
   * Register or update one repository and persist the result.
   * @param draft - the caller's fields; omitted `repoId` generates one.
   * @returns the stored record.
   */
  upsert(draft: RepoDraft): Promise<RepoRecord>
  /**
   * Drop one repository and persist the result.
   * @param repoId - the record to drop.
   * @returns true when a record was removed.
   */
  remove(repoId: RepoId): Promise<boolean>
  /**
   * Drop every repository of one machine, for machine removal.
   * @param nodeId - the machine whose registrations go away.
   * @returns the number of records removed.
   */
  removeByNode(nodeId: NodeId): Promise<number>
}

/** Build a repository store over one document. */
export interface RepoStoreDeps {
  /** Absolute path of the JSON document. */
  readonly file: string
  /** Injectable clock, so tests do not depend on wall time. */
  readonly now?: () => Date
}

/** The on-disk document. */
interface RepoDocument {
  readonly version: number
  readonly repos: readonly RepoRecord[]
}

/** Whether an unknown parsed value is a record this module wrote. */
function isRepoRecord(value: unknown): value is RepoRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<Record<keyof RepoRecord, unknown>>
  return typeof record.repoId === 'string'
    && typeof record.nodeId === 'string'
    && typeof record.repoPath === 'string'
    && typeof record.name === 'string'
    && typeof record.createdAt === 'string'
}

/**
 * Parse a document, refusing anything this module did not write.
 * @param text - the file content.
 * @param file - the path, for the diagnostic.
 * @returns the stored records.
 * @throws when the JSON, the version, or a record is not readable.
 */
function parseDocument(text: string, file: string): readonly RepoRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${file} is not a repository document`)
  }
  const document = parsed as Partial<RepoDocument>
  if (document.version !== DOCUMENT_VERSION) {
    throw new Error(
      `${file} carries version ${String(document.version)}; this build reads ${String(DOCUMENT_VERSION)}`,
    )
  }
  const repos = document.repos
  if (!Array.isArray(repos) || !repos.every(isRepoRecord)) {
    throw new Error(`${file} carries a repository entry this build does not understand`)
  }
  return repos
}

/** Serialize the document with a trailing newline. */
function serialize(repos: readonly RepoRecord[]): string {
  return `${JSON.stringify({ version: DOCUMENT_VERSION, repos } satisfies RepoDocument, null, 2)}\n`
}

/**
 * The name to show for a path no caller named.
 * @param repoPath - absolute POSIX path of the checkout.
 * @returns the last path segment, or the whole path when it has none.
 */
export function defaultRepoName(repoPath: string): string {
  const base = posix.basename(repoPath)
  return base === '' || base === '/' ? repoPath : base
}

/**
 * Build a repository store over one document.
 * @param deps - the document path and an optional clock.
 * @returns the store; call {@link RepoStore.load} before serving reads.
 */
export function createRepoStore(deps: RepoStoreDeps): RepoStore {
  const now = deps.now ?? (() => new Date())
  let repos: RepoRecord[] = []
  let loaded = false

  const requireLoaded = (): void => {
    if (!loaded) throw new Error('repository store read before load()')
  }

  // Serialize the candidate, not the live list: a failed commit must leave
  // `repos` untouched, or the next successful write commits an unreported
  // mutation whose caller already saw an error.
  const persist = async (next: readonly RepoRecord[]): Promise<void> => {
    const content = serialize(next)
    // The lock is a `wx` create beside the document and never creates its
    // directory, so the first write into a fresh harness home must seed it.
    await mkdir(dirname(deps.file), { recursive: true, mode: 0o700 })
    await withFileLock(deps.file, async () => {
      await writeFileAtomic(deps.file, content, { mode: FILE_MODE })
    })
  }

  return {
    async load() {
      try {
        repos = [...parseDocument(await readFile(deps.file, 'utf8'), deps.file)]
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        repos = []
      }
      loaded = true
      return repos
    },

    list() {
      requireLoaded()
      return repos
    },

    get(repoId) {
      requireLoaded()
      return repos.find(repo => repo.repoId === repoId)
    },

    find(ref) {
      requireLoaded()
      return repos.find(repo => repo.nodeId === ref.nodeId && repo.repoPath === ref.repoPath)
    },

    async upsert(draft) {
      requireLoaded()
      const existing = draft.repoId === undefined ? undefined : repos.find(repo => repo.repoId === draft.repoId)
      // A re-registration of the same path keeps the name the user chose; a
      // record moved to another path re-derives it, because a name taken from
      // the old path would misdescribe the new one.
      const kept = existing !== undefined && existing.repoPath === draft.repoPath
      const record: RepoRecord = {
        repoId: existing?.repoId ?? draft.repoId ?? brandString<RepoId>(randomUUID()),
        nodeId: draft.nodeId,
        repoPath: draft.repoPath,
        name: draft.name?.trim() || (kept ? existing.name : '') || defaultRepoName(draft.repoPath),
        createdAt: existing?.createdAt ?? now().toISOString(),
      }
      const next = existing === undefined
        ? [...repos, record]
        : repos.map(repo => (repo.repoId === record.repoId ? record : repo))
      await persist(next)
      repos = next
      return record
    },

    async remove(repoId) {
      requireLoaded()
      const next = repos.filter(repo => repo.repoId !== repoId)
      if (next.length === repos.length) return false
      await persist(next)
      repos = next
      return true
    },

    async removeByNode(nodeId) {
      requireLoaded()
      const next = repos.filter(repo => repo.nodeId !== nodeId)
      const removed = repos.length - next.length
      if (removed === 0) return 0
      await persist(next)
      repos = next
      return removed
    },
  }
}
