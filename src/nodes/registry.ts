/**
 * The durable record of the remote machines a user has configured.
 *
 * The document lives under the harness home and is replaced atomically under a
 * cross-process lock, so two harness processes never interleave a read-render
 * -commit cycle. Records carry the node's shared secret; every projection that
 * leaves this module drops it, and {@link toNodeView} is the only supported way
 * to produce one.
 *
 * @module dsh-remote-worktree/nodes/registry
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { NodeId } from '../ids.ts'
import { randomUUID } from 'node:crypto'

/**
 * Document revision. Revision 1 stored `host`/`port` on the record; revision 2
 * stores a transport that says how the host reaches the daemon.
 */
const DOCUMENT_VERSION = 2

/** Owner-only permissions: the document holds a secret per node. */
const FILE_MODE = 0o600

/** Port a daemon listens on when a caller names none. */
const DEFAULT_REMOTE_PORT = 7801

/**
 * The title a node gets when its caller named none.
 * @param transport - how the host reaches the daemon.
 * @returns the SSH destination, or the direct address.
 */
export function defaultNodeTitle(transport: NodeTransport): string {
  return transport.kind === 'ssh' ? transport.target : `${transport.host}:${String(transport.port)}`
}

/**
 * How the host reaches one machine's daemon.
 *
 * `ssh` is the only transport a caller may create: the host picks a free local
 * port and forwards it to the daemon's loopback port over an SSH connection,
 * which is what the deployment documentation tells operators to set up by
 * hand. `direct` exists so a document written before the SSH transport keeps
 * loading; nothing creates one, and it names an address the operator reached
 * some other way.
 */
export type NodeTransport =
  | {
    readonly kind: 'ssh'
    /** `ssh` destination: `user@host`, or a `~/.ssh/config` alias. */
    readonly target: string
    /** SSH port; omitted defers to the operator's `ssh` configuration. */
    readonly sshPort?: number
    /** Identity file; omitted defers to the operator's `ssh` configuration. */
    readonly identityFile?: string
  }
  | {
    readonly kind: 'direct'
    /** Host the daemon is reachable at. */
    readonly host: string
    /** TCP port the daemon is reachable at. */
    readonly port: number
  }

/** One configured remote machine. */
export interface NodeRecord {
  /** Stable generated id; never the target, so renaming a machine is free. */
  readonly nodeId: NodeId
  /** Display title. Defaults to the `ssh` destination. */
  readonly title: string
  /** How the host reaches this machine's daemon. */
  readonly transport: NodeTransport
  /** TCP port the daemon listens on, on the machine's own loopback. */
  readonly remotePort: number
  /**
   * The daemon's shared secret. Kept out of every view this module returns to
   * callers that render to a browser or a model; a later phase moves it to the
   * credential seam, at which point this field becomes a reference.
   */
  readonly token: string
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 instant of the last accepted mutation. */
  readonly updatedAt: string
}

/** What a browser or another plugin may see: a record without its secret. */
export interface NodeView {
  readonly nodeId: NodeId
  readonly title: string
  readonly transport: NodeTransport
  readonly remotePort: number
  /** Whether a secret is configured; the value itself never travels. */
  readonly hasToken: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

/** Fields a caller supplies when creating or updating a node. */
export interface NodeDraft {
  readonly nodeId?: NodeId
  readonly title?: string
  readonly transport: NodeTransport
  readonly remotePort?: number
  readonly token: string
}

/** What the registry needs from its owner. */
export interface NodeRegistryDeps {
  /** Absolute path of the JSON document. */
  readonly file: string
  /** Injectable clock, so tests do not depend on wall time. */
  readonly now?: () => Date
}

/** The node registry. */
export interface NodeRegistry {
  /**
   * Read the document into memory. Missing is not an error: a fresh install has
   * no nodes. A malformed or future-versioned document fails loud rather than
   * being treated as empty, because silently starting empty would strand every
   * workspace anchored to a node.
   * @returns the loaded records, in document order.
   */
  load(): Promise<readonly NodeRecord[]>
  /** Every configured node, in stable document order. */
  list(): readonly NodeRecord[]
  /**
   * One node by id.
   * @param nodeId - the generated record id.
   * @returns the record, or undefined when no node carries that id.
   */
  get(nodeId: NodeId): NodeRecord | undefined
  /**
   * Create or update one node and persist the result.
   * @param draft - the caller's fields; omitted `nodeId` generates one.
   * @returns the stored record.
   */
  upsert(draft: NodeDraft): Promise<NodeRecord>
  /**
   * Remove one node and persist the result.
   * @param nodeId - the record to remove.
   * @returns true when a record was removed.
   */
  remove(nodeId: NodeId): Promise<boolean>
}

/** The on-disk document. */
interface NodeDocument {
  readonly version: number
  readonly nodes: readonly NodeRecord[]
}

/** Whether an unknown parsed value is a transport this build understands. */
function isTransport(value: unknown): value is NodeTransport {
  if (typeof value !== 'object' || value === null) return false
  const transport = value as Record<string, unknown>
  if (transport['kind'] === 'ssh') {
    return typeof transport['target'] === 'string'
      && (transport['sshPort'] === undefined || typeof transport['sshPort'] === 'number')
      && (transport['identityFile'] === undefined || typeof transport['identityFile'] === 'string')
  }
  if (transport['kind'] === 'direct') {
    return typeof transport['host'] === 'string' && typeof transport['port'] === 'number'
  }
  return false
}

/** Whether an unknown parsed value is a record this module wrote. */
function isNodeRecord(value: unknown): value is NodeRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['nodeId'] === 'string'
    && typeof record['title'] === 'string'
    && isTransport(record['transport'])
    && typeof record['remotePort'] === 'number'
    && typeof record['token'] === 'string'
    && typeof record['createdAt'] === 'string'
    && typeof record['updatedAt'] === 'string'
}

/**
 * Read one revision-1 record as the revision-2 record.
 *
 * Revision 1 recorded a reachable address and nothing else, which is what the
 * `direct` transport still means. The record therefore carries over with no
 * field lost and no id change, so every repository and worktree already
 * anchored to this node keeps resolving.
 * @param value - the parsed revision-1 entry.
 * @param index - the entry's position, for the diagnostic.
 * @returns the equivalent revision-2 record.
 * @throws when the entry is not one this build can read.
 */
function migrateV1(value: unknown, index: number): NodeRecord {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const fields = ['nodeId', 'title', 'host', 'token', 'createdAt', 'updatedAt'] as const
  for (const field of fields) {
    if (typeof record[field] !== 'string') {
      throw new Error(`node entry ${String(index)} from revision 1 carries no usable "${field}"`)
    }
  }
  if (typeof record['port'] !== 'number') {
    throw new Error(`node entry ${String(index)} from revision 1 carries no usable "port"`)
  }
  const port = record['port'] as number
  const host = record['host'] as string
  return {
    nodeId: brandString<NodeId>(record['nodeId'] as string),
    title: record['title'] as string,
    transport: { kind: 'direct', host, port },
    remotePort: port,
    token: record['token'] as string,
    createdAt: record['createdAt'] as string,
    updatedAt: record['updatedAt'] as string,
  }
}

/**
 * Parse a document, refusing anything this module did not write.
 * @param text - the file content.
 * @param file - the path, used only to name the failure.
 * @returns the parsed nodes.
 * @throws when the JSON is malformed, the version is unsupported, or a record
 *   does not match the stored fields.
 */
function parseDocument(text: string, file: string): readonly NodeRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON`, { cause: error })
  }
  const document = parsed as Partial<NodeDocument>
  const nodes = document.nodes
  if (!Array.isArray(nodes)) throw new Error(`${file} carries no node list`)
  if (document.version === 1) return nodes.map(migrateV1)
  if (document.version !== DOCUMENT_VERSION) {
    throw new Error(
      `${file} has document version ${String(document.version)}; this build reads ${String(DOCUMENT_VERSION)}`,
    )
  }
  if (!nodes.every(isNodeRecord)) {
    throw new Error(`${file} carries a node entry this build does not understand`)
  }
  return nodes
}

/** Serialize the document with a trailing newline. */
function serialize(nodes: readonly NodeRecord[]): string {
  return `${JSON.stringify({ version: DOCUMENT_VERSION, nodes } satisfies NodeDocument, null, 2)}\n`
}

/**
 * Project a record for a caller that may render it.
 * @param record - the stored record.
 * @returns the record without its secret, plus the presence flag a form needs.
 */
export function toNodeView(record: NodeRecord): NodeView {
  return {
    nodeId: record.nodeId,
    title: record.title,
    transport: record.transport,
    remotePort: record.remotePort,
    hasToken: record.token.length > 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * Build a node registry over one document.
 * @param deps - the document path and an optional clock.
 * @returns the registry; call {@link NodeRegistry.load} before serving reads.
 */
export function createNodeRegistry(deps: NodeRegistryDeps): NodeRegistry {
  const now = deps.now ?? (() => new Date())
  let nodes: NodeRecord[] = []
  let loaded = false

  // Serialize the candidate, not the live list: a failed commit must leave
  // `nodes` untouched, or the next successful write commits an unreported
  // mutation whose caller already saw an error.
  const persist = async (next: readonly NodeRecord[]): Promise<void> => {
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
        nodes = [...parseDocument(await readFile(deps.file, 'utf8'), deps.file)]
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        nodes = []
      }
      loaded = true
      return nodes
    },

    list() {
      if (!loaded) throw new Error('node registry read before load()')
      return nodes
    },

    get(nodeId) {
      if (!loaded) throw new Error('node registry read before load()')
      return nodes.find(node => node.nodeId === nodeId)
    },

    async upsert(draft) {
      if (!loaded) throw new Error('node registry written before load()')
      const stamp = now().toISOString()
      const existing = draft.nodeId === undefined
        ? undefined
        : nodes.find(node => node.nodeId === draft.nodeId)
      const record: NodeRecord = {
        nodeId: existing?.nodeId ?? draft.nodeId ?? brandString<NodeId>(randomUUID()),
        title: draft.title?.trim() || defaultNodeTitle(draft.transport),
        transport: draft.transport,
        remotePort: draft.remotePort ?? DEFAULT_REMOTE_PORT,
        token: draft.token,
        createdAt: existing?.createdAt ?? stamp,
        updatedAt: stamp,
      }
      const next = existing === undefined
        ? [...nodes, record]
        : nodes.map(node => (node.nodeId === record.nodeId ? record : node))
      await persist(next)
      nodes = next
      return record
    },

    async remove(nodeId) {
      if (!loaded) throw new Error('node registry written before load()')
      const next = nodes.filter(node => node.nodeId !== nodeId)
      if (next.length === nodes.length) return false
      await persist(next)
      nodes = next
      return true
    },
  }
}
