/**
 * The browser half of dsh-remote-ssh-worktree.
 *
 * It owns exactly one surface: a settings section that manages the machines
 * this deployment can reach, the repositories registered on them, and the
 * remote worktrees cut from those repositories. Everything it renders comes
 * from the host's management routes under `/dsh-remote-ssh-worktree`, which the
 * host half registers; the browser side has no privileged access and no other
 * way in.
 *
 * The module is the plugin body: it registers the locale dictionaries and
 * contributes one component. The section's stylesheet travels inside
 * `Section`, which attaches it to the document when it is first evaluated. The
 * component itself receives all data and callbacks through its prop shares.
 *
 * @module dsh-remote-ssh-worktree/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { AnchorId, NodeId, RepoId } from '../ids.ts'
import type { DirListing, RemoteWorktreesFace, Snapshot } from './Section.tsx'
import { RemoteWorktreesSection } from './Section.tsx'
import type { RemoteWorktreesKey } from './locales.ts'
import { en, NS, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Remote machine, repository, and worktree management copy. */
    'remote-worktrees': RemoteWorktreesKey
  }
}

/** The host route prefix the management API is registered under. */
const API = '/dsh-remote-ssh-worktree'

/** How the host reaches a machine's daemon. */
interface NodeTransport {
  readonly kind: 'ssh'
  readonly target: string
  readonly sshPort?: number
  readonly identityFile?: string
}

/** One machine as the host projects it. */
interface NodeView {
  readonly nodeId: NodeId
  readonly title: string
  readonly transport: NodeTransport
  readonly hasToken: boolean
}

/** The connection states a machine can report. */
type NodeState = 'idle' | 'connecting' | 'ready' | 'failed' | 'disconnected'

/** One machine's connection state. */
interface NodeStatus {
  readonly nodeId: NodeId
  readonly state: NodeState
  /** The local port carrying this machine's traffic, once a forward is up. */
  readonly localPort?: number
  /** The step in flight, while a connection attempt is still running. */
  readonly progress?: {
    readonly phase: 'checking' | 'reusing' | 'fetching' | 'uploading' | 'starting'
    readonly version: string
    readonly asset?: string
    readonly source?: 'cache' | 'network'
  }
  readonly error?: string
}

/** One registered repository with the live state read from its machine. */
interface RepoReport {
  readonly repo: {
    readonly repoId: RepoId
    readonly nodeId: NodeId
    readonly repoPath: string
    readonly name: string
  }
  readonly state?: { readonly branch: string | null; readonly clean: boolean }
  readonly error?: string
}

/** One worktree joined with its repository's live state. */
interface WorktreeStatus {
  readonly anchor: {
    readonly anchorId: AnchorId
    readonly nodeId: NodeId
    readonly repoPath: string
    readonly name: string
    readonly branch: string
    readonly anchorPath: string
    readonly remoteRoot: string
  }
  readonly repo?: { readonly branch: string | null; readonly clean: boolean }
  readonly error?: string
}

/**
 * Translate this plugin's copy at call time, so a language change is followed
 * without anyone subscribing to locale state.
 */
type Translate = (key: RemoteWorktreesKey, params?: Record<string, unknown>) => string

/**
 * One JSON request against the management API.
 * @param t - the locale seat, for the failure the host did not describe.
 * @param path - the route below the plugin's prefix.
 * @param init - the request to send.
 * @returns the parsed body.
 * @throws when the host answered with a non-2xx status.
 */
async function call<T>(t: Translate, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    headers: init?.body === undefined ? {} : { 'content-type': 'application/json' },
    ...init,
  })
  // A failure body is optional: a proxy or an aborted request can answer with
  // something that is not JSON, and the status below is the fact that matters.
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error: unknown }).error)
      : t('requestFailed', { status: response.status })
    throw new Error(message)
  }
  return body as T
}

/**
 * Build the injected face over the host routes.
 * @param t - the locale seat every request failure is reported through.
 * @returns the face the section drives.
 */
function sectionFace(t: Translate): RemoteWorktreesFace {
  return {
    async load(): Promise<Snapshot> {
      const [listing, repos, worktrees] = await Promise.all([
        call<{ nodes: readonly NodeView[]; statuses: readonly NodeStatus[] }>(t, '/nodes'),
        call<{ repos: readonly RepoReport[] }>(t, '/repos'),
        call<{ worktrees: readonly WorktreeStatus[] }>(t, '/worktrees'),
      ])
      return { nodes: listing.nodes, statuses: listing.statuses, repos: repos.repos, worktrees: worktrees.worktrees }
    },
    async addNode(draft) {
      await call(t, '/nodes', { method: 'POST', body: JSON.stringify(draft) })
    },
    async removeNode(nodeId) {
      await call(t, `/nodes/${encodeURIComponent(nodeId)}`, { method: 'DELETE' })
    },
    async connectNode(nodeId) {
      await call(t, `/nodes/${encodeURIComponent(nodeId)}/connect`, { method: 'POST' })
    },
    async disconnectNode(nodeId) {
      await call(t, `/nodes/${encodeURIComponent(nodeId)}/disconnect`, { method: 'POST' })
    },
    async addRepo(draft) {
      await call(t, '/repos', { method: 'POST', body: JSON.stringify(draft) })
    },
    async removeRepo(repoId) {
      await call(t, `/repos/${encodeURIComponent(repoId)}`, { method: 'DELETE' })
    },
    async listDirs(nodeId, path): Promise<DirListing> {
      const query = new URLSearchParams({ path })
      return await call<DirListing>(t, `/nodes/${encodeURIComponent(nodeId)}/dirs?${query.toString()}`)
    },
    async createWorktree(draft) {
      await call(t, '/worktrees', { method: 'POST', body: JSON.stringify(draft) })
    },
    async removeWorktree(anchorId) {
      await call(t, `/worktrees/${encodeURIComponent(anchorId)}?force=true`, { method: 'DELETE' })
    },
    async bringBack(anchorId) {
      await call(t, `/worktrees/${encodeURIComponent(anchorId)}/bring-back`, { method: 'POST' })
    },
  }
}

/** Plugin name used by the client loader and by diagnostics. */
export const name = 'remote-worktrees-ui'

/** Client services this plugin needs before it activates. */
export const inject = ['slots', 'locale']

/**
 * Mount the browser half.
 * @param ctx - the client context this plugin was mounted on.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote-ssh-worktree: dictionaries')
  // Bound, not called: the seat reads the current language on every use, so a
  // request that fails after a language change is reported in the new one.
  const face = sectionFace(ctx.locale.bind(NS))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote-worktrees',
    order: 30,
    // The nav label is read at render time, so it follows a language change
    // without the shell subscribing to locale state.
    label: () => ctx.locale.bind(NS)('title'),
    locale: NS,
    inject: () => face,
  }, RemoteWorktreesSection))
}
