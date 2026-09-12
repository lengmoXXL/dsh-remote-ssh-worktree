/**
 * The routing bash executor the plugin registers as `ctx.shell`.
 *
 * A plain object, like the other two routers. It composes **two** factory
 * executors rather than one: the sandboxed executor for local work, and the
 * bare one for remote work.
 *
 * The bare delegate is not redundant. `bash-sandbox` resolves its argv through
 * `ctx.sandbox`, which wraps a process for **this host's** kernel; handing that
 * argv to a remote cwd would ship a bwrap invocation to the node. On the node
 * the machine itself is the boundary, so the remote branch must take the path
 * that never asks the host sandbox anything.
 *
 * The request/spec split stays the delegate's: whichever executor owns the
 * workdir does both the resolving and the running, so timeout, output caps, and
 * managed-environment handling keep their shipped behavior on both sides.
 *
 * @module dsh-remote-ssh-worktree/plugin/routing/shell
 */

import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellExecutor,
  ShellProcess,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { AnchorRoute } from '../../anchors/store.ts'
import { classifyPath } from './classify.ts'

/**
 * The members this provider implements, narrowed from the seam class so the
 * object literal is checkable without inheriting `Service`.
 */
export type ShellExecutorContract = Pick<
  ShellExecutor,
  'resolve' | 'run' | 'start' | 'sandboxMode'
>

/** What the routing executor needs from its owner. */
export interface RoutingShellDeps {
  /** The composed sandboxed executor serving every local workdir. */
  readonly localShell: ShellExecutor
  /** The composed bare executor serving every remote workdir. */
  readonly remoteShell: ShellExecutor
  /** Every anchor this plugin currently owns. */
  readonly anchors: () => readonly AnchorRoute[]
}

/**
 * Build the routing bash executor.
 * @param deps - the two composed delegates and the live anchors.
 * @returns an object satisfying the shell seam, ready for `ctx.provide`.
 */
export function createRoutingShellExecutor(deps: RoutingShellDeps): ShellExecutorContract {
  /**
   * Whether a workdir belongs to a node.
   * @param workdir - the spec's resolved working directory.
   * @returns true when the remote delegate must own the execution.
   */
  const isRemote = (workdir: string): boolean =>
    classifyPath(workdir, undefined, deps.anchors()).kind === 'remote'

  return {
    // The fact is "the mode this executor confines at by default", and the
    // executor genuinely confines every LOCAL command at the deployment's mode
    // through the sandboxed delegate. Reporting `undefined` instead would make
    // the plugin uncomposable with `dsh-base`: `permission-presets` refuses to
    // mount over an executor that claims not to confine at all. The remote
    // branch is bounded by the machine.
    get sandboxMode(): SandboxMode | undefined {
      return deps.localShell.sandboxMode
    },

    resolve(request: ShellExecRequest): ShellExecSpec {
      return isRemote(request.workdir ?? '')
        ? deps.remoteShell.resolve(request)
        : deps.localShell.resolve(request)
    },

    run(spec: ShellExecSpec): Promise<ShellRunResult> {
      return isRemote(spec.workdir) ? deps.remoteShell.run(spec) : deps.localShell.run(spec)
    },

    start(spec: ShellExecSpec): ShellProcess {
      return isRemote(spec.workdir) ? deps.remoteShell.start(spec) : deps.localShell.start(spec)
    },
  }
}
