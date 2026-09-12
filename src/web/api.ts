/**
 * The management API behind the plugin's Web routes, and the adapter that
 * mounts it.
 *
 * The rules and the transport are separate halves of one module, in that order:
 * {@link handleNodeApi} takes a normalized request and returns a status plus a
 * JSON body, so validation, which fields may leave the host, and which failures
 * are client errors are all exercised without opening a socket; the adapter
 * below it owns only reading a bounded body, parsing the URL, and writing JSON
 * back.
 *
 * A node's token never appears in a response. {@link toNodeView} is the only
 * projection used here.
 *
 * The route is registered through `ctx.get('webServer')` rather than an
 * injected dependency, because a non-Web profile (headless, SDK) has no HTTP
 * server and the plugin must still load there.
 *
 * @module dsh-remote-ssh-worktree/web/api
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NodeConnections, NodeStatus } from '../nodes/connections.ts'
import type { NodeId } from '../ids.ts'
import type { NodeRegistry, NodeTransport, NodeView } from '../nodes/registry.ts'
import { toNodeView } from '../nodes/registry.ts'
import { asAnchorId, asNodeId, asRepoId } from '../ids.ts'
import type { RepoRecord, RepoStore } from '../repos/store.ts'
import type { WorktreeManager } from '../worktree/manager.ts'

/** One normalized request, already routed to this API's prefix. */
export interface ApiRequest {
  /** Upper-case HTTP method. */
  readonly method: string
  /** Path below the API prefix; always starts with `/`. */
  readonly path: string
  /** Parsed query string. */
  readonly query: URLSearchParams
  /** Parsed JSON body, or undefined when the request carried none. */
  readonly body: unknown
}

/** One normalized response. */
export interface ApiResponse {
  /** HTTP status code. */
  readonly status: number
  /** JSON-serializable body. */
  readonly body: unknown
}

/** What the API needs from the plugin. */
export interface ManagementApiDeps {
  /** Durable node records. */
  readonly registry: NodeRegistry
  /** Durable repository records. */
  readonly repos: RepoStore
  /** Live connections. */
  readonly connections: NodeConnections
  /** The remote worktree lifecycle. */
  readonly worktrees: WorktreeManager
}

/** One repository as the API reports it: the record plus its live state. */
interface RepoReport {
  readonly repo: RepoRecord
  /** Live facts from the machine, absent when it is not connected. */
  readonly state?: { readonly branch: string | null; readonly clean: boolean }
  /** Why the live facts are missing. */
  readonly error?: string
}

/** A failure carrying the status this API answers with. */
class ApiError extends Error {
  /** HTTP status this failure answers with. */
  readonly status: number

  /**
   * @param status - the HTTP status to answer with.
   * @param message - the client-facing reason.
   */
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Whether an unknown value is a plain object with the named string field. */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : undefined
}

/**
 * Read a required non-empty string field, or fail as a client error.
 * @param body - the parsed request body.
 * @param key - the field name.
 * @returns the trimmed value.
 * @throws ApiError 400 when the field is missing or empty.
 */
function requireString(body: unknown, key: string): string {
  const value = stringField(body, key)?.trim()
  if (value === undefined || value === '') {
    throw new ApiError(400, `"${key}" is required and must be a non-empty string`)
  }
  return value
}

/**
 * Read the SSH destination a caller wants to reach a machine through.
 *
 * Only the destination is required: the SSH port and identity file default to
 * whatever the operator's own `ssh` configuration already says, so a
 * `~/.ssh/config` alias works exactly as written.
 * @param body - the parsed request body.
 * @returns the stored transport.
 * @throws ApiError 400 when the destination is missing or a field is unusable.
 */
function requireTransport(body: unknown): NodeTransport {
  const ssh = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)['ssh']
    : undefined
  if (typeof ssh !== 'object' || ssh === null) {
    throw new ApiError(400, '"ssh" is required and must name how to reach the machine')
  }
  const fields = ssh as Record<string, unknown>
  const target = typeof fields['target'] === 'string' ? fields['target'].trim() : ''
  if (target === '') {
    throw new ApiError(400, '"ssh.target" is required and must be a non-empty string')
  }
  const portField = fields['port']
  if (portField !== undefined
    && (typeof portField !== 'number' || !Number.isInteger(portField) || portField < 1 || portField > 65535)) {
    throw new ApiError(400, '"ssh.port" must be between 1 and 65535')
  }
  const identity = typeof fields['identityFile'] === 'string' ? fields['identityFile'].trim() : ''
  return {
    kind: 'ssh',
    target,
    ...portField === undefined ? {} : { sshPort: portField as number },
    ...identity === '' ? {} : { identityFile: identity },
  }
}

/** Split a path below the prefix into its segments. */
function segments(path: string): string[] {
  return path.split('/').filter(segment => segment !== '')
}

/** The status list joined onto the node list, so one response renders a table. */
function withStatuses(
  registry: NodeRegistry,
  connections: NodeConnections,
): { nodes: readonly NodeView[]; statuses: readonly NodeStatus[] } {
  return {
    nodes: registry.list().map(toNodeView),
    statuses: connections.list(),
  }
}

/**
 * Resolve a node id to a stored record, or fail as a client error.
 * @param registry - the durable registry.
 * @param nodeId - the path segment.
 * @returns the record.
 * @throws ApiError 404 when no node carries that id.
 */
function requireNode(registry: NodeRegistry, nodeId: NodeId) {
  const record = registry.get(nodeId)
  if (record === undefined) throw new ApiError(404, `no node "${nodeId}"`)
  return record
}

/**
 * Resolve a caller's path against a machine's own filesystem rules.
 * @param deps - the management dependencies.
 * @param nodeId - the machine to ask.
 * @param path - the caller's path, absolute or starting with `~`.
 * @returns the canonical absolute path on that machine.
 * @throws ApiError 409 when the machine is not connected, 502 when it cannot
 *   resolve the path.
 */
async function resolveRemotePath(
  deps: ManagementApiDeps,
  nodeId: NodeId,
  path: string,
): Promise<string> {
  const channel = deps.connections.channel(nodeId)
  if (channel === undefined) throw new ApiError(409, `node "${nodeId}" is not connected`)
  const resolved = await channel.request('fs.resolve', { path })
  if (resolved.canonicalPath === undefined) throw new ApiError(502, 'the daemon returned no path')
  return resolved.canonicalPath
}

/**
 * Read one repository's live state from its machine.
 *
 * A repository outlives the connection to its machine, so an unreachable one
 * still lists; only the live facts go missing, and `error` says why.
 * @param deps - the management dependencies.
 * @param record - the stored repository.
 * @returns the record joined with its live state.
 */
async function reportRepo(deps: ManagementApiDeps, record: RepoRecord): Promise<RepoReport> {
  const channel = deps.connections.channel(record.nodeId)
  if (channel === undefined) {
    return { repo: record, error: `node "${record.nodeId}" is not connected` }
  }
  try {
    const state = await channel.request('git.repoState', { repoPath: record.repoPath })
    return { repo: record, state: { branch: state.branch, clean: state.clean } }
  } catch (error) {
    return { repo: record, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Handle the repository half of the API.
 * @param request - the normalized request.
 * @param parts - path segments below `/repos`.
 * @param deps - the management dependencies.
 * @returns the status and JSON body to answer with.
 */
async function handleRepos(
  request: ApiRequest,
  parts: readonly string[],
  deps: ManagementApiDeps,
): Promise<ApiResponse> {
  const [rawRepoId] = parts
  // A route segment is a string from an untrusted request; this is where it
  // becomes an id. Everything below passes the branded value.
  const repoId = rawRepoId === undefined ? undefined : asRepoId(rawRepoId)
  const notAllowed = new ApiError(405, `${request.method} is not allowed on ${request.path}`)

  if (repoId === undefined) {
    if (request.method === 'GET') {
      const reports = await Promise.all(deps.repos.list().map(repo => reportRepo(deps, repo)))
      return { status: 200, body: { repos: reports } }
    }
    if (request.method === 'POST') {
      // Both required fields are read before any lookup, so a malformed body is
      // always a 400 rather than whichever existence check runs first.
      const nodeId = asNodeId(requireString(request.body, 'nodeId'))
      const requested = requireString(request.body, 'repoPath')
      requireNode(deps.registry, nodeId)
      const repoPath = await resolveRemotePath(deps, nodeId, requested)
      const channel = deps.connections.channel(nodeId)
      if (channel === undefined) throw new ApiError(409, `node "${nodeId}" is not connected`)
      try {
        // Registration is the one moment a path is proven to be a checkout;
        // every later read trusts the record and answers from the daemon.
        await channel.request('git.repoState', { repoPath })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new ApiError(400, `"${repoPath}" is not a git repository on that machine: ${reason}`)
      }
      const existing = deps.repos.find({ nodeId, repoPath })
      const name = stringField(request.body, 'name')?.trim()
      const record = await deps.repos.upsert({
        ...existing === undefined ? {} : { repoId: existing.repoId },
        nodeId,
        repoPath,
        ...name === undefined || name === '' ? {} : { name },
      })
      return { status: existing === undefined ? 201 : 200, body: { repo: await reportRepo(deps, record) } }
    }
    throw notAllowed
  }

  const record = deps.repos.get(repoId)
  if (record === undefined) throw new ApiError(404, `no repository "${repoId}"`)

  if (request.method === 'GET') {
    return { status: 200, body: { repo: await reportRepo(deps, record) } }
  }
  if (request.method === 'DELETE') {
    const held = deps.worktrees.anchorsIn({ nodeId: record.nodeId, repoPath: record.repoPath })
    if (held.length > 0) {
      throw new ApiError(
        409,
        `${String(held.length)} worktree(s) still belong to this repository; remove them first`,
      )
    }
    return { status: 200, body: { deleted: await deps.repos.remove(repoId) } }
  }
  throw notAllowed
}

/**
 * Handle the worktree half of the API.
 * @param request - the normalized request.
 * @param parts - path segments below `/worktrees`.
 * @param deps - the management dependencies.
 * @returns the status and JSON body to answer with.
 */
async function handleWorktrees(
  request: ApiRequest,
  parts: readonly string[],
  deps: ManagementApiDeps,
): Promise<ApiResponse> {
  const [rawAnchorId, action] = parts
  const anchorId = rawAnchorId === undefined ? undefined : asAnchorId(rawAnchorId)

  if (anchorId === undefined) {
    if (request.method === 'GET') {
      return { status: 200, body: { worktrees: await deps.worktrees.list() } }
    }
    if (request.method === 'POST') {
      const rawRepoId = stringField(request.body, 'repoId')?.trim()
      const repoId = rawRepoId === undefined || rawRepoId === '' ? undefined : asRepoId(rawRepoId)
      const target = repoId === undefined
        ? {
            nodeId: asNodeId(requireString(request.body, 'nodeId')),
            repoPath: requireString(request.body, 'repoPath'),
          }
        : (() => {
            const record = deps.repos.get(repoId)
            if (record === undefined) throw new ApiError(404, `no repository "${repoId}"`)
            return { nodeId: record.nodeId, repoPath: record.repoPath }
          })()
      const baseRef = stringField(request.body, 'baseRef')
      const anchor = await deps.worktrees.create({
        ...target,
        name: requireString(request.body, 'name'),
        ...baseRef === undefined ? {} : { baseRef },
      })
      // A worktree cut by path still belongs to a repository, so the tree the
      // UI renders stays complete whichever surface cut it. Registered after
      // the cut, so a refused checkout records nothing.
      if (deps.repos.find(target) === undefined) await deps.repos.upsert(target)
      return { status: 201, body: { worktree: anchor } }
    }
    throw new ApiError(405, `${request.method} is not allowed on ${request.path}`)
  }

  // Opening and closing are workspace registration, not git: the checkout on
  // the machine is untouched either way.
  if (action === 'open' || action === 'close') {
    if (request.method !== 'POST') throw new ApiError(405, `${request.method} is not allowed on ${request.path}`)
    const worktree = action === 'open'
      ? await deps.worktrees.open(anchorId)
      : await deps.worktrees.close(anchorId)
    return { status: 200, body: { worktree } }
  }

  if (action === undefined && request.method === 'DELETE') {
    return {
      status: 200,
      body: {
        removal: await deps.worktrees.remove(anchorId, {
          force: request.query.get('force') === 'true',
          // Deleting a branch is an explicit ask: this plugin owns worktrees,
          // not branches, so the default leaves it behind.
          deleteBranch: request.query.get('deleteBranch') === 'true',
        }),
      },
    }
  }

  throw new ApiError(404, `unknown endpoint ${request.method} ${request.path}`)
}

/**
 * Handle one management request.
 * @param request - the normalized request.
 * @param deps - the registry, connection manager, and worktree lifecycle.
 * @returns the status and JSON body to answer with.
 */
export async function handleNodeApi(request: ApiRequest, deps: ManagementApiDeps): Promise<ApiResponse> {
  try {
    const parts = segments(request.path)
    const head = parts[0]

    if (head === 'worktrees') return await handleWorktrees(request, parts.slice(1), deps)
    if (head === 'repos') return await handleRepos(request, parts.slice(1), deps)

    const [, rawNodeId, action] = parts
    const nodeId = rawNodeId === undefined ? undefined : asNodeId(rawNodeId)

    if (head !== 'nodes') {
      throw new ApiError(404, `unknown endpoint ${request.method} ${request.path}`)
    }

    if (nodeId === undefined) {
      if (request.method === 'GET') return { status: 200, body: withStatuses(deps.registry, deps.connections) }
      if (request.method === 'POST') {
        const title = stringField(request.body, 'title')
        const record = await deps.registry.upsert({
          transport: requireTransport(request.body),
          token: requireString(request.body, 'token'),
          ...title === undefined ? {} : { title },
        })
        return { status: 201, body: { node: toNodeView(record) } }
      }
      throw new ApiError(405, `${request.method} is not allowed on ${request.path}`)
    }

    const record = requireNode(deps.registry, nodeId)

    if (action === undefined) {
      if (request.method === 'GET') {
        return { status: 200, body: { node: toNodeView(record), status: deps.connections.status(nodeId) } }
      }
      if (request.method === 'DELETE') {
        deps.connections.disconnect(nodeId)
        const deleted = await deps.registry.remove(nodeId)
        // A repository is only reachable through its machine, so its records
        // go with it rather than surviving as entries that can never load.
        if (deleted) await deps.repos.removeByNode(nodeId)
        return { status: 200, body: { deleted } }
      }
      if (request.method === 'PATCH') {
        // A patch that names a destination replaces it; one that does not keeps
        // the stored one, so re-pointing a machine is a deliberate act.
        const ssh = typeof request.body === 'object' && request.body !== null
          ? (request.body as Record<string, unknown>)['ssh']
          : undefined
        const updated = await deps.registry.upsert({
          nodeId,
          transport: ssh === undefined ? record.transport : requireTransport(request.body),
          token: stringField(request.body, 'token') ?? record.token,
          title: stringField(request.body, 'title') ?? record.title,
        })
        return { status: 200, body: { node: toNodeView(updated) } }
      }
      throw new ApiError(405, `${request.method} is not allowed on ${request.path}`)
    }

    if (action === 'connect' || action === 'test') {
      if (request.method !== 'POST') throw new ApiError(405, `${request.method} is not allowed on ${request.path}`)
      await deps.connections.connect(record)
      return { status: 200, body: { status: deps.connections.status(nodeId) } }
    }

    if (action === 'disconnect') {
      if (request.method !== 'POST') throw new ApiError(405, `${request.method} is not allowed on ${request.path}`)
      deps.connections.disconnect(nodeId)
      return { status: 200, body: { status: deps.connections.status(nodeId) } }
    }

    if (action === 'dirs') {
      if (request.method !== 'GET') throw new ApiError(405, `${request.method} is not allowed on ${request.path}`)
      const channel = deps.connections.channel(nodeId)
      if (channel === undefined) throw new ApiError(409, `node "${nodeId}" is not connected`)
      const path = request.query.get('path') ?? '~'
      const resolved = await channel.request('fs.resolve', { path })
      if (resolved.canonicalPath === undefined) throw new ApiError(502, 'the daemon returned no path')
      const listing = await channel.request('fs.listDir', { path: resolved.canonicalPath })
      return {
        status: 200,
        body: {
          path: resolved.canonicalPath,
          entries: listing.map(entry => ({
            name: entry.name,
            type: entry.type,
            path: entry.target.canonicalPath,
            ...entry.size === undefined ? {} : { size: entry.size },
          })),
        },
      }
    }

    throw new ApiError(404, `unknown endpoint ${request.method} ${request.path}`)
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, body: { error: error.message } }
    return {
      status: 502,
      body: { error: error instanceof Error ? error.message : String(error) },
    }
  }
}

/** The path prefix this plugin owns. */
const API_PREFIX = '/dsh-remote-ssh-worktree'

/** Bound on one management request body. */
const MAX_BODY_BYTES = 1 << 20

/** Read a bounded request body and parse it as JSON. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (total === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write one normalized response. */
function writeResponse(response: ServerResponse, result: ApiResponse): void {
  const payload = JSON.stringify(result.body)
  response.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/**
 * Register the management routes on the host's Web server.
 *
 * A missing Web server is not a failure: it means this profile serves no
 * browser, and the plugin's model-facing behavior is unaffected.
 * @param ctx - the host context.
 * @param deps - the registry and connection manager the API reads.
 */
export function registerNodeApi(ctx: Context, deps: ManagementApiDeps): void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname.slice(API_PREFIX.length)
      let body: unknown
      try {
        body = await readJsonBody(request)
      } catch (error) {
        writeResponse(response, {
          status: 400,
          body: { error: error instanceof Error ? error.message : String(error) },
        })
        return
      }
      const result = await handleNodeApi({
        method: request.method ?? 'GET',
        path: path === '' ? '/' : path,
        query: url.searchParams,
        body,
      }, deps)
      writeResponse(response, result)
    },
  }))
}
