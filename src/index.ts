/**
 * dsh-remote-workspace — remote execution worlds for DeepSeek Harness.
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
 * The same mount also serves the right Sidebar's terminal: one WebSocket that
 * turns into a PTY, resolving the Session's workspace and allocating the shell
 * through the terminal seam this plugin routes. It never asks which machine
 * owns a directory — a routed workspace simply starts its shell there — and it
 * is deliberately not confined by the Session's sandbox mode, because that
 * policy bounds what the *agent* may do while a terminal is the person's own
 * shell.
 *
 * @module dsh-remote-workspace
 */

import type { Context } from '@deepseek-ai/cordis'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalTtyRuntime } from './local/tty.ts'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { autoconnect } from './models/autoconnect.ts'
import { createNodeConnections, DEFAULT_HANDSHAKE_TIMEOUT_MS } from './models/machines.ts'
import { createWorktreeManager, workspaceLabel } from './models/worktrees.ts'
import { registerNodeApi } from './plugin/api.ts'
import { createRoutingFileSystem } from './plugin/routing/fs.ts'
import { createRoutingShellExecutor } from './plugin/routing/shell.ts'
import { createRoutingSubprocessRuntime } from './plugin/routing/subprocess.ts'
import { createRoutingTty } from './plugin/routing/tty.ts'
import { AGENT_VERSION } from './remote/agent/install.ts'
import { DEFAULT_FORWARD_TIMEOUT_MS } from './remote/ssh.ts'
import { createAnchorStore } from './storage/anchors.ts'
import { createNodeRegistry } from './storage/nodes.ts'
import type { NodeId } from './storage/nodes.ts'
import { createRepoStore } from './storage/repos.ts'
import { registerTerminalSocket } from './terminal/host/socket.ts'
import type { TerminalSettings } from './terminal/host/terminal.ts'
import { SOCKET_PATH } from './terminal/shared/wire.ts'

/** Plugin name used by the Loader and by diagnostics. */
export const name = 'dsh-remote-workspace'

/**
 * Services this plugin needs before it activates. `sandboxPolicy` is required
 * by the composed local delegate, and declaring it here keeps provision of
 * `ctx.fs` behind that dependency rather than racing it.
 */
export const inject = ['sandboxPolicy']

/**
 * The stock rows providing the seams this plugin routes. The host plane holds
 * one implementation per service, so a deployment disables these in its own
 * patch layer before this plugin can publish; see the README's install section.
 */
const STOCK_ROWS = ['subprocess', 'fs-sandbox', 'bash-sandbox', 'pwsh-sandbox']

/**
 * Publish one routing seam, naming the profile edit when a stock row got there
 * first.
 *
 * `ctx.provide` refuses a service that already has a provider: the failure a
 * deployment sees when it added this plugin without disabling the stock rows.
 * That refusal names the row, not the fix, so this reports the fix.
 *
 * The value is cast because each seam type extends `Service`, whose protected
 * members make it nominal: a plain object cannot be assigned structurally.
 * Every router is checked against its seam's contract factory instead.
 * @param ctx - the host context.
 * @param service - the service being published.
 * @param value - the routing implementation.
 * @returns the disposer `ctx.provide` returned.
 */
function publishSeam(ctx: Context, service: 'fs' | 'subprocess' | 'shell' | 'tty', value: unknown): unknown {
  try {
    return ctx.provide(service as never, value as never)
  } catch (cause) {
    const hint = `${name}: ctx.${service} already has a provider, so this router is inert. Disable `
      + `${STOCK_ROWS.join(', ')} in the profile's cordis.patch.yml — see the README's install section.`
    // This runs inside an `inject` callback, whose rejection the registry keeps
    // rather than surfaces, and `dsh web` prints no logger record: without the
    // write, a deployment that skipped the profile edit boots looking healthy
    // while the stock provider keeps serving every remote path.
    ctx.logger.error(hint)
    process.stderr.write(`${hint}\n`)
    throw new Error(hint, { cause })
  }
}

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
   * Root directory every managed worktree is cut under, on every machine.
   *
   * Defaults to `~/.dsh/worktrees`, resolved against the machine's own home; an
   * absolute path is used verbatim. A checkout lands at
   * `<root>/<repository>/<name>`, never inside the repository.
   */
  worktreeRoot?: string
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
  /**
   * Program the Sidebar terminal runs. Unset — the default — runs the machine's
   * own login shell, resolved on whichever machine owns the workspace, so one
   * deployment spanning a Mac and a Linux node starts zsh on one and bash on
   * the other.
   */
  shell?: string
  /**
   * Arguments after {@link Config.shell}. Defaults to `['-l']`, a login shell,
   * which is what makes the user's own profile load. Ignored while `shell` is
   * unset.
   */
  shellArgs?: string[]
  /** TERM-to-KILL grace for one terminal session, in milliseconds. Defaults to 3000. */
  graceMs?: number
}

/** Validated plugin config. */
export const Config: z<Config> = z.object({
  dataDir: z.string(),
  remoteRipgrep: z.string(),
  worktreeRoot: z.string(),
  sshForwardTimeoutMs: z.number().step(1).min(1),
  daemonHandshakeTimeoutMs: z.number().step(1).min(1),
  shell: z.string(),
  shellArgs: z.array(z.string()),
  graceMs: z.number().step(1).min(1),
})

/** Root managed worktrees are cut under when the config names none. */
const DEFAULT_WORKTREE_ROOT = '~/.dsh/worktrees'

/** What a deployment runs when it names no shell. */
const LOGIN_SHELL_VIA_SH = ['/bin/sh', '-c', 'exec "${SHELL:-/bin/sh}" -l'] as const

/**
 * Resolve the argv a terminal is started with.
 * @param config - the validated plugin config.
 * @returns the program and its arguments.
 */
function shellArgv(config: Config): readonly string[] {
  if (config.shell === undefined || config.shell.length === 0) return LOGIN_SHELL_VIA_SH
  const args = config.shellArgs !== undefined && config.shellArgs.length > 0 ? config.shellArgs : ['-l']
  return [config.shell, ...args]
}

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
    cacheDir: join(dataDir, 'agents'),
    agentVersion: AGENT_VERSION,
    sshForwardTimeoutMs: config.sshForwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS,
    daemonHandshakeTimeoutMs: config.daemonHandshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
  })
  // A deployment that just loaded should not need a person to click Connect per
  // machine, and a restored session should find its workspace reachable. The
  // pass gives up quietly, so its failures are read from the section.
  ctx.effect(() => {
    const stop = autoconnect({ records: () => registry.list(), connections })
    return () => {
      stop()
      connections.dispose()
    }
  })

  // The local machine reads paths and runs git in this process instead of over
  // a connection, so which nodes those are is settled once.
  const isLocalNode = (nodeId: NodeId): boolean => registry.get(nodeId)?.transport.kind === 'local'

  const configuredRoot = config.worktreeRoot ?? DEFAULT_WORKTREE_ROOT
  if (configuredRoot !== '~' && !configuredRoot.startsWith('~/') && !configuredRoot.startsWith('/')) {
    throw new Error(`worktreeRoot must be absolute, "~", or "~/…": "${configuredRoot}"`)
  }
  /** Where managed checkouts live on one machine. */
  const worktreeRoot = (nodeId: NodeId): string => {
    if (!configuredRoot.startsWith('~')) return configuredRoot
    const home = isLocalNode(nodeId) ? homedir() : connections.status(nodeId).info?.homedir
    if (home === undefined) {
      throw new Error(`the home directory of "${nodeId}" is unknown; connect that machine first`)
    }
    return posix.join(home, configuredRoot.slice(1))
  }

  const worktrees = createWorktreeManager({
    anchors: anchorStore,
    repos,
    channel: nodeId => connections.channel(nodeId),
    isLocalNode,
    worktreeRoot,
    workspace: {
      async register(anchor) {
        // The title is what a person reads in the workspace list, so it names
        // the checkout, the repository, and the machine — never the opaque ids
        // this plugin routes by. A machine whose record is gone leaves its id
        // as the last word on the title.
        const node = registry.get(anchor.nodeId)
        await workspaceRegistry(ctx)?.create(anchor.anchorPath, workspaceLabel({
          machine: node?.title ?? anchor.nodeId,
          repoPath: anchor.repoPath,
          repoName: repos.find({ nodeId: anchor.nodeId, repoPath: anchor.repoPath })?.name,
          // A directory opened as itself names no checkout; the repository is
          // the end of its title.
          ...anchor.kind === 'worktree' ? { name: anchor.name } : {},
        }))
      },
      async unregister(anchor) {
        const service = workspaceRegistry(ctx)
        const record = await service?.resolveByPath(anchor.anchorPath)
        if (record !== undefined && service !== undefined) await service.delete(record.id)
      },
      async registered(anchor) {
        const record = await workspaceRegistry(ctx)?.resolveByPath(anchor.anchorPath)
        return record !== undefined
      },
    },
  })

  registerNodeApi(ctx, { registry, repos, connections, worktrees, worktreeRoot })

  // The Sidebar terminal is registered here rather than behind `ctx.tty`: the
  // socket handler reads the seam when a person opens a terminal, so a profile
  // that composes another provider still gets a working terminal.
  const argv = shellArgv(config)
  const terminalSettings: TerminalSettings = {
    shell: argv[0]!,
    shellArgs: argv.slice(1),
    // A terminal is the only consumer here that cares, and both names are what
    // every full-screen program reads to decide what it may draw.
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    graceMs: config.graceMs ?? 3000,
  }
  registerTerminalSocket(ctx, SOCKET_PATH, terminalSettings)

  const subprocessScope = ctx.isolate('subprocess')
  subprocessScope.plugin(LocalSubprocessRuntime)
  subprocessScope.inject(['subprocess'], (scoped) => {
    const router = createRoutingSubprocessRuntime({
      localProc: scoped.subprocess,
      anchors: () => anchorStore.routes(),
      channel: nodeId => connections.channel(nodeId),
      ...config.remoteRipgrep === undefined ? {} : { remoteRipgrep: config.remoteRipgrep },
    })
    return publishSeam(ctx, 'subprocess', router)
  })

  const fsScope = ctx.isolate('fs')
  fsScope.plugin(SandboxedFileSystem, {})
  fsScope.inject(['fs'], (scoped) => {
    const router = createRoutingFileSystem({
      localFs: scoped.fs,
      anchors: () => anchorStore.routes(),
      channel: nodeId => connections.channel(nodeId),
    })
    return publishSeam(ctx, 'fs', router)
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
      return publishSeam(ctx, 'shell', router)
    })
  })

  // The terminal router composes the local PTY provider and answers for a
  // node's directories with the daemon's own terminals. The local provider is
  // the node-pty one rather than the subprocess seam because a terminal is a
  // view whose size a person changes while the shell keeps running, and only a
  // provider that holds the PTY can carry that.
  const ttyScope = ctx.isolate('tty')
  ttyScope.plugin(LocalTtyRuntime)
  ttyScope.inject(['tty'], (scoped) => {
    const router = createRoutingTty({
      localTty: scoped.tty,
      anchors: () => anchorStore.routes(),
      channel: nodeId => connections.channel(nodeId),
    })
    return publishSeam(ctx, 'tty', router)
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

