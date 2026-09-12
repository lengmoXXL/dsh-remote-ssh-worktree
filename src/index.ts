/**
 * dsh-remote-worktree — remote execution worlds for DeepSeek Harness.
 *
 * The plugin replaces the execution-world seams with routing versions: a path
 * that belongs to a remote anchor is served by that node's daemon over the
 * wire, and every other path is served by the factory implementation this
 * plugin composes in an isolated scope. The stock file, shell, terminal, and
 * language-server tools therefore run against a remote worktree unchanged.
 *
 * Nothing here inherits an implementation class. Each seam is registered with
 * `ctx.provide`, which is the primitive Cordis' own `Service` constructor
 * calls; the factory implementations are composed as separate instances and
 * reached through delegation.
 *
 * With no anchor configured the plugin is inert: every path classifies as
 * local and the routers delegate every call to the factory implementation.
 *
 * @module dsh-remote-worktree
 */

import type { Context } from '@deepseek-ai/cordis'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { createAnchorStore } from './anchors/store.ts'
import { registerWorktreeCommand } from './commands.ts'
import { createNodeConnections, DEFAULT_HANDSHAKE_TIMEOUT_MS } from './nodes/connections.ts'
import { createNodeRegistry, defaultNodeTitle } from './nodes/registry.ts'
import { createRepoStore } from './repos/store.ts'
import { DEFAULT_FORWARD_TIMEOUT_MS } from './transport/tunnel.ts'
import { createRoutingFileSystem } from './routing/fs.ts'
import { createRoutingShellExecutor } from './routing/shell.ts'
import { createRoutingSubprocessRuntime } from './routing/subprocess.ts'
import { registerWorktreeTools } from './tools.ts'
import { createWorktreeManager, worktreeLabel } from './worktree/manager.ts'
import { registerNodeApi } from './web/mount.ts'

/** Plugin name used by the Loader and by diagnostics. */
export const name = 'remote-worktree'

/**
 * Services this plugin needs before it activates. `sandboxPolicy` is required
 * by the composed local delegate, and declaring it here keeps provision of
 * `ctx.fs` behind that dependency rather than racing it.
 */
export const inject = ['sandboxPolicy']

/** Deployment-varying choices for this plugin. */
export interface Config {
  /**
   * Directory holding the node registry. Defaults to
   * `$DSH_HOME/remote-worktrees`, which the anchor directory store also uses.
   */
  dataDir?: string
  /**
   * Remote binary a host-resolved ripgrep is rewritten to. Defaults to `rg`.
   */
  remoteRipgrep?: string
  /**
   * How long the SSH forward may take to start accepting connections, in
   * milliseconds. Defaults to {@link DEFAULT_FORWARD_TIMEOUT_MS}.
   *
   * A deployment across a slow link or through a bastion raises this; the
   * failure it prevents is a forward that was still negotiating when the
   * budget ran out.
   */
  sshForwardTimeoutMs?: number
  /**
   * How long the daemon may take to answer the handshake once its forward is
   * up, in milliseconds. Defaults to {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}.
   *
   * This is what turns "the daemon is not running" into a report instead of a
   * call that never returns, so a deployment should not raise it far.
   */
  daemonHandshakeTimeoutMs?: number
}

/** Validated plugin config. */
export const Config: z<Config> = z.object({
  dataDir: z.string(),
  remoteRipgrep: z.string(),
  sshForwardTimeoutMs: z.number().step(1).min(1),
  daemonHandshakeTimeoutMs: z.number().step(1).min(1),
})

/**
 * Mount the plugin.
 *
 * @param ctx - the host context this plugin was mounted on.
 * @param config - the validated plugin config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const dataDir = config.dataDir ?? dshHomePath('remote-worktrees')

  const registry = createNodeRegistry({ file: join(dataDir, 'nodes.json') })
  await registry.load()

  const anchorStore = createAnchorStore({ root: join(dataDir, 'anchors') })
  await anchorStore.load()

  const repos = createRepoStore({ file: join(dataDir, 'repos.json') })
  await repos.load()

  const connections = createNodeConnections({
    sshForwardTimeoutMs: config.sshForwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS,
    daemonHandshakeTimeoutMs: config.daemonHandshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
  })
  ctx.effect(() => () => {
    connections.dispose()
  })

  const worktrees = createWorktreeManager({
    anchors: anchorStore,
    channel: nodeId => connections.channel(nodeId),
    workspace: {
      async register(anchor) {
        // The title is what a person reads in the workspace list, so it names
        // the machine, the repository, and the checkout — never the opaque ids
        // this plugin routes by.
        const node = registry.get(anchor.nodeId)
        await workspaceRegistry(ctx)?.create(anchor.anchorPath, worktreeLabel({
          machine: node?.title ?? (node === undefined ? anchor.nodeId : defaultNodeTitle(node.transport)),
          repoPath: anchor.repoPath,
          repoName: repos.find({ nodeId: anchor.nodeId, repoPath: anchor.repoPath })?.name,
          name: anchor.name,
        }))
      },
      async unregister(anchor) {
        const service = workspaceRegistry(ctx)
        const record = await service?.resolveByPath(anchor.anchorPath)
        if (record !== undefined && service !== undefined) await service.delete(record.id)
      },
    },
  })

  registerNodeApi(ctx, { registry, repos, connections, worktrees })
  registerWorktreeTools(ctx, { registry, connections, worktrees })
  registerWorktreeCommand(ctx, { registry, connections, worktrees })

  const subprocessScope = ctx.isolate('subprocess')
  subprocessScope.plugin(LocalSubprocessRuntime)
  subprocessScope.inject(['subprocess'], (scoped) => {
    const router = createRoutingSubprocessRuntime({
      localProc: scoped.subprocess,
      anchors: () => anchorStore.routes(),
      channel: nodeId => connections.channel(nodeId),
      ...config.remoteRipgrep === undefined ? {} : { remoteRipgrep: config.remoteRipgrep },
    })
    return ctx.provide('subprocess', router as unknown as SubprocessRuntime)
  })

  const fsScope = ctx.isolate('fs')
  fsScope.plugin(SandboxedFileSystem, {})
  fsScope.inject(['fs'], (scoped) => {
    const router = createRoutingFileSystem({
      localFs: scoped.fs,
      anchors: () => anchorStore.routes(),
      channel: nodeId => connections.channel(nodeId),
    })
    // The cast is the entire cost of not inheriting: `FileSystem` extends
    // `Service`, whose `protected` members make the type nominal, so a plain
    // object cannot be assigned structurally. The object above is checked
    // against `FileSystemContract` first, and consumers only ever call the
    // public seam methods.
    return ctx.provide('fs', router as unknown as FileSystem)
  })

  // Two independent shell scopes: a local command keeps the host sandbox wrap,
  // a remote command must never touch it. Each scope's `subprocess` resolves to
  // the routing runtime above, so the remote delegate's spawn lands on the node.
  const localShellScope = ctx.isolate('shell')
  localShellScope.plugin(SandboxBashExecutor, {})
  const remoteShellScope = ctx.isolate('shell')
  remoteShellScope.plugin(LocalBashExecutor)
  // Each scope waits for its own delegate; the routing shell is published only
  // once both exist, so no consumer can observe a half-routed executor.
  localShellScope.inject(['shell'], (localScoped) => {
    remoteShellScope.inject(['shell'], (remoteScoped) => {
      const router = createRoutingShellExecutor({
        localShell: localScoped.shell,
        remoteShell: remoteScoped.shell,
        anchors: () => anchorStore.routes(),
      })
      return ctx.provide('shell', router as unknown as ShellExecutor)
    })
  })
}

/** The handle a workspace record is addressed by. */
interface WorkspaceHandle {
  readonly id: string
}

/**
 * The slice of the workspace seam this plugin uses.
 *
 * Declared structurally rather than imported: the plugin depends on the
 * operations it calls, not on the registry package, so a deployment composing
 * a different registry with the same operations still works.
 */
interface WorkspaceRegistry {
  /**
   * Register an existing directory as a workspace.
   * @param path - the canonical directory path.
   * @param title - the display title.
   * @returns the record, existing or created.
   */
  create(path: string, title?: string): Promise<WorkspaceHandle>
  /**
   * Find the workspace owning a path.
   * @param path - the canonical directory path.
   * @returns the record, or undefined when the path is not registered.
   */
  resolveByPath(path: string): Promise<WorkspaceHandle | undefined>
  /**
   * Drop a workspace registration without touching the directory.
   * @param id - the record id.
   * @returns whether a record was removed.
   */
  delete(id: string): Promise<boolean>
}

/**
 * The deployment's workspace registry, when one is composed.
 *
 * Read dynamically rather than injected: a headless or SDK profile may compose
 * no registry, and the plugin must still load and route there.
 * @param ctx - the host context.
 * @returns the registry, or undefined when this deployment composes none.
 */
function workspaceRegistry(ctx: Context): WorkspaceRegistry | undefined {
  return ctx.get('workspaceRegistry')
}

