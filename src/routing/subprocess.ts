/**
 * The routing subprocess runtime the plugin registers as `ctx.subprocess`.
 *
 * A plain object, like the filesystem router: `ctx.provide` is the primitive
 * Cordis' own `Service` constructor calls, so nothing is inherited here.
 *
 * Two structural facts shape this module.
 *
 * First, `spawn` returns its handle **synchronously** while a remote start
 * needs a round trip. The handle is therefore a local proxy: it exists
 * immediately, queues `terminate` and `waitForExit` until the daemon has
 * answered, and lets `done` reject when the start itself failed.
 *
 * Second, a collected reader is read **synchronously** while the daemon is
 * reached asynchronously. The proxy keeps a local mirror of each stream and
 * fills it at exit, which is when every documented consumer — the bash
 * executor, the spill policy — actually reads. Collected output that this
 * design cannot fetch without an async reader is fetched once, completely,
 * before `done` settles.
 *
 * `'pipe'` output is refused for a remote cwd rather than silently collected:
 * a consumer that asked for a live stream must learn it cannot have one.
 *
 * @module dsh-remote-worktree/routing/subprocess
 */

import { PassThrough } from 'node:stream'
import type { Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessRuntime,
  SubprocessSpawnSpec,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { SpPipeFrame } from '../../shared/protocol.ts'
import type { ChannelLookup, NodeChannel } from '../node/channel.ts'
import { NodeRequestError } from '../node/channel.ts'
import type { AnchorRoute } from './classify.ts'
import { classifyPath } from './classify.ts'

/**
 * The members this provider implements, narrowed from the seam class so the
 * object literal is checkable without inheriting `Service`.
 */
export type SubprocessRuntimeContract = Pick<
  SubprocessRuntime,
  'resolveExecutable' | 'spawn' | 'spawnTerminal'
>

/** What the routing subprocess runtime needs from its owner. */
export interface RoutingSubprocessDeps {
  /** The composed factory implementation serving every local cwd. */
  readonly localProc: SubprocessRuntime
  /** Every anchor this plugin currently owns. */
  readonly anchors: () => readonly AnchorRoute[]
  /** Resolves the live channel for a node. */
  readonly channel: ChannelLookup
  /**
   * Remote binary a packaged ripgrep is rewritten to. The search tools resolve
   * a host-side `rg` and hand that absolute path to this seam, which does not
   * exist on the node.
   */
  readonly remoteRipgrep?: string
}

/**
 * How often a remote terminal asks the daemon for new output.
 *
 * A terminal's output is a live stream while the wire serves retained windows,
 * so the proxy polls. The interval is the interactive latency floor: small
 * enough that a prompt appears promptly, large enough that an idle terminal does
 * not flood the connection.
 */
const TERMINAL_POLL_MS = 40

/** One stream's local mirror of the daemon's retained window. */
class CollectedMirror implements SubprocessOutputReader {
  private readonly chunks: Buffer[] = []
  /** Whole-stream offset of the first retained byte. */
  private start = 0
  /** Whole-stream offset one past the last retained byte. */
  private end = 0
  /** True when an earlier read reported that bytes had already been dropped. */
  private dropped = false
  private readonly maxBytes: number

  /**
   * @param maxBytes - the in-memory cap the caller asked the daemon for.
   */
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  /** Append one fetched window and trim the head to the cap. */
  push(bytes: Buffer): void {
    if (bytes.length === 0) return
    this.chunks.push(bytes)
    this.end += bytes.length
    let retained = this.end - this.start
    while (retained > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0]!
      const overflow = retained - this.maxBytes
      if (head.length <= overflow) {
        this.chunks.shift()
        this.start += head.length
      } else {
        this.chunks[0] = head.subarray(overflow)
        this.start += overflow
      }
      this.dropped = true
      retained = this.end - this.start
    }
  }

  /** The whole-stream offset a caller should resume from. */
  get nextOffset(): number {
    return this.end
  }

  /**
   * Read everything captured since `fromByte`.
   * @param fromByte - whole-stream byte offset to resume from.
   * @returns the delta text, the next offset, and whether the offset was lost.
   */
  readFrom(fromByte: number): SubprocessOutputRead {
    if (fromByte < this.start) {
      return {
        text: Buffer.concat(this.chunks).toString('utf8'),
        nextOffset: this.end,
        lossy: true,
      }
    }
    if (fromByte >= this.end) {
      return { text: '', nextOffset: this.end, lossy: this.dropped }
    }
    const slice = Buffer.concat(this.chunks).subarray(fromByte - this.start)
    return { text: slice.toString('utf8'), nextOffset: this.end, lossy: this.dropped }
  }
}

/**
 * Build the proxy handle for one remote spawn.
 * @param channel - the live node channel.
 * @param remoteCwd - the canonical remote working directory.
 * @param spec - the caller's fully specified spawn request.
 * @returns the handle, valid before the daemon has answered.
 * @throws when the caller asked for a disposition this design cannot carry.
 */
function createRemoteHandle(
  channel: NodeChannel,
  remoteCwd: string,
  spec: SubprocessSpawnSpec,
): SubprocessHandle {
  const stdoutMirror = typeof spec.stdio.stdout === 'object'
    ? new CollectedMirror(spec.stdio.stdout.maxBytes)
    : undefined
  const stderrMirror = typeof spec.stdio.stderr === 'object'
    ? new CollectedMirror(spec.stdio.stderr.maxBytes)
    : undefined

  // A piped stream is pushed, not retained, so its `Readable` is fed straight
  // from the daemon's frames. Registration happens before `sp.spawn` so no
  // chunk can arrive before there is a handler to receive it, and frames that
  // race the spawn answer are held until the id they belong to is known.
  const stdoutPipe = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
  const stderrPipe = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
  const bufferedFrames: SpPipeFrame[] = []
  let procId: string | undefined
  let offPipe: (() => void) | undefined

  const deliverPipeFrame = (frame: SpPipeFrame): void => {
    if (frame.procId !== procId) return
    const target = frame.stream === 'stdout' ? stdoutPipe : stderrPipe
    target?.write(Buffer.from(frame.data, 'base64'))
  }

  if (stdoutPipe !== undefined || stderrPipe !== undefined) {
    offPipe = channel.onPipeFrame((frame) => {
      if (procId === undefined) {
        bufferedFrames.push(frame)
        return
      }
      deliverPipeFrame(frame)
    })
  }

  /** Stop pushing and end every piped stream, exactly once. */
  const closePipes = (): void => {
    offPipe?.()
    offPipe = undefined
    stdoutPipe?.end()
    stderrPipe?.end()
  }

  let startFailure: unknown
  let terminated = false

  let resolveDone: (outcome: SubprocessOutcome) => void = () => {}
  let rejectDone: (error: unknown) => void = () => {}
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const stdinStream: Writable | undefined = spec.stdio.stdin === 'pipe'
    ? new PassThrough()
    : undefined

  /** Fetch every remaining byte of one stream until the daemon stops advancing. */
  const drain = async (id: string, stream: 'stdout' | 'stderr', mirror: CollectedMirror): Promise<void> => {
    for (;;) {
      const read = await channel.request('sp.readOutput', {
        procId: id,
        stream,
        fromByte: mirror.nextOffset,
      })
      if (read.data.length === 0) return
      mirror.push(Buffer.from(read.data, 'base64'))
      if (read.nextOffset <= mirror.nextOffset) return
    }
  }

  const run = async (): Promise<void> => {
    let id: string
    try {
      const started = await channel.request('sp.spawn', {
        argv: [...spec.argv],
        cwd: remoteCwd,
        stdin: spec.stdio.stdin === 'pipe'
          ? 'pipe'
          : spec.stdio.stdin === 'ignore'
            ? 'ignore'
            : { data: spec.stdio.stdin.data },
        stdout: collectSpec(spec.stdio.stdout),
        stderr: collectSpec(spec.stdio.stderr),
        graceMs: spec.graceMs,
        ...spec.env === undefined ? {} : { env: definedEnv(spec.env) },
      })
      id = started.procId
      procId = id
      // Flush whatever arrived while the id was in flight; order is preserved
      // because the daemon pushes in order on one connection.
      for (const frame of bufferedFrames.splice(0)) deliverPipeFrame(frame)
    } catch (error) {
      startFailure = error
      closePipes()
      rejectDone(error)
      return
    }

    if (terminated) await channel.request('sp.terminate', { procId: id }).catch(() => {})
    if (typeof spec.stdio.stdin === 'object') {
      await channel.request('sp.writeStdin', { procId: id, data: spec.stdio.stdin.data }).catch(() => {})
      await channel.request('sp.closeStdin', { procId: id }).catch(() => {})
    }
    if (stdinStream !== undefined) {
      stdinStream.on('data', (chunk: Buffer) => {
        void channel.request('sp.writeStdin', { procId: id, data: chunk.toString('utf8') }).catch(() => {})
      })
      stdinStream.on('end', () => {
        void channel.request('sp.closeStdin', { procId: id }).catch(() => {})
      })
    }

    try {
      await channel.request('sp.waitForExit', { procId: id })
      if (stdoutMirror !== undefined) await drain(id, 'stdout', stdoutMirror)
      if (stderrMirror !== undefined) await drain(id, 'stderr', stderrMirror)
      const outcome = await channel.request('sp.outcome', { procId: id })
      closePipes()
      resolveDone({
        exitCode: outcome?.exitCode ?? null,
        signal: (outcome?.signal ?? null) as NodeJS.Signals | null,
      })
    } catch (error) {
      closePipes()
      rejectDone(error)
    }
  }

  void run()

  const collected: SubprocessCollectedOutputs = {
    ...stdoutMirror === undefined ? {} : { stdout: stdoutMirror },
    ...stderrMirror === undefined ? {} : { stderr: stderrMirror },
  }

  return {
    stdin: stdinStream,
    stdout: stdoutPipe,
    stderr: stderrPipe,
    collected,
    done,
    terminate() {
      terminated = true
      if (procId === undefined) return
      void channel.request('sp.terminate', { procId }).catch(() => {})
    },
    async waitForExit(signal?: AbortSignal): Promise<boolean> {
      if (startFailure !== undefined) return false
      // The daemon's own wait is the observable fact; the local `done` settles
      // only after the final drain, which is strictly later.
      await done.catch(() => {})
      return signal?.aborted !== true
    },
  }
}

/** Project a seam output disposition onto the wire form. */
function collectSpec(mode: SubprocessSpawnSpec['stdio']['stdout']): 'inherit' | 'pipe' | { maxBytes: number } {
  if (mode === 'pipe') return 'pipe'
  return typeof mode === 'object' ? { maxBytes: mode.maxBytes } : 'inherit'
}

/** Drop undefined entries from a spawn environment. */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * Rewrite a host-only executable path into something the node can run.
 *
 * The search tools resolve a packaged `rg` on the host and hand this seam that
 * absolute path; the node has its own binary under a bare name. Any other
 * absolute path is passed through, and the daemon reports it missing.
 * @param argv - the caller's argv.
 * @param remoteRipgrep - the configured remote binary name.
 * @returns the argv to send.
 */
function rewriteExecutable(argv: readonly string[], remoteRipgrep: string): readonly string[] {
  const head = argv[0]
  if (head === undefined || !head.startsWith('/')) return argv
  const base = head.slice(head.lastIndexOf('/') + 1)
  if (base !== 'rg' && base !== 'rg.exe') return argv
  return [remoteRipgrep, ...argv.slice(1)]
}


/**
 * Allocate one remote terminal and proxy its live output.
 *
 * Unlike `spawn`, this seam method is already asynchronous, so the allocation
 * round trip is awaited rather than queued. What still cannot cross the wire is
 * a push stream, so the proxy polls the daemon's retained window into a local
 * `PassThrough`; a consumer sees the same `Readable` it would locally, one poll
 * interval behind.
 * @param channel - the live node channel.
 * @param remoteCwd - the canonical remote working directory.
 * @param spec - the caller's fully specified terminal request.
 * @returns the live terminal handle.
 */
async function createRemoteTerminal(
  channel: NodeChannel,
  remoteCwd: string,
  spec: SubprocessTerminalSpawnSpec,
): Promise<SubprocessTerminalHandle> {
  const started = await channel.request('term.spawn', {
    argv: [...spec.argv],
    cwd: remoteCwd,
    rows: spec.rows,
    cols: spec.cols,
    graceMs: spec.graceMs,
    ...spec.env === undefined ? {} : { env: spec.env },
  })

  const output = new PassThrough()
  const decoder = new StringDecoder('utf8')
  let offset = 0
  let finished = false
  let pumping = false
  let timer: NodeJS.Timeout | undefined

  let resolveDone: (outcome: SubprocessOutcome) => void = () => {}
  const done = new Promise<SubprocessOutcome>((resolve) => {
    resolveDone = resolve
  })

  /** Publish the outcome once and stop polling. */
  const finish = (outcome: SubprocessOutcome): void => {
    if (finished) return
    finished = true
    if (timer !== undefined) clearInterval(timer)
    output.end(decoder.end())
    resolveDone(outcome)
  }

  /** One poll: pull what the daemon retains, then ask whether it exited. */
  const tick = async (): Promise<void> => {
    if (pumping || finished) return
    pumping = true
    try {
      const read = await channel.request('term.read', { termId: started.termId, fromByte: offset })
      offset = read.nextOffset
      if (read.data.length > 0) output.write(decoder.write(Buffer.from(read.data, 'base64')))
      const outcome = await channel.request('term.outcome', { termId: started.termId })
      if (outcome !== null) {
        finish({ exitCode: outcome.exitCode, signal: outcome.signal as NodeJS.Signals | null })
      }
    } catch (error) {
      // A dropped transport ends the terminal: the handle settles rather than
      // hanging on output that can no longer arrive.
      finish({ exitCode: null, signal: null })
      void error
    } finally {
      pumping = false
    }
  }

  timer = setInterval(() => void tick(), TERMINAL_POLL_MS)
  timer.unref()
  void tick()

  const foreground = (value: { processGroupId: number; inputWaiting: boolean } | null): SubprocessTerminalForeground | undefined =>
    value === null ? undefined : value

  return {
    pid: started.pid,
    output,
    done,
    async write(data: string): Promise<void> {
      await channel.request('term.write', { termId: started.termId, data })
    },
    async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
      return foreground(await channel.request('term.inspectForeground', { termId: started.termId }))
    },
    async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
      const result = await channel.request('term.signalForeground', {
        termId: started.termId,
        signal: signal as SubprocessTerminalSignal,
      })
      return result.processGroupId
    },
    async terminate(): Promise<void> {
      if (finished) return
      await channel.request('term.terminate', { termId: started.termId })
      // One last pull so output produced during teardown is not lost.
      try {
        const read = await channel.request('term.read', { termId: started.termId, fromByte: offset })
        offset = read.nextOffset
        if (read.data.length > 0) output.write(decoder.write(Buffer.from(read.data, 'base64')))
      } catch {
        // Teardown already removed the window; the buffered output stands.
      }
      const outcome = await channel.request('term.outcome', { termId: started.termId }).catch(() => null)
      finish({
        exitCode: outcome?.exitCode ?? null,
        signal: (outcome?.signal ?? null) as NodeJS.Signals | null,
      })
    },
  }
}

/**
 * Build the routing subprocess runtime.
 * @param deps - the composed local delegate, the live anchors, and channel lookup.
 * @returns an object satisfying the subprocess seam, ready for `ctx.provide`.
 */
export function createRoutingSubprocessRuntime(
  deps: RoutingSubprocessDeps,
): SubprocessRuntimeContract {
  const remoteRipgrep = deps.remoteRipgrep ?? 'rg'

  return {
    // Executable lookup carries no working directory, so it cannot be routed:
    // a remote spawn resolves its own executable on the node instead.
    resolveExecutable(command, env, signal) {
      return deps.localProc.resolveExecutable(command, env, signal)
    },

    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const route = classifyPath(spec.cwd, undefined, deps.anchors())
      if (route.kind === 'local') return deps.localProc.spawn(spec)
      if (route.kind === 'ambiguous') {
        throw new Error(
          `"${route.remotePath}" belongs to more than one node (${route.nodeIds.join(', ')}); `
          + 'address it as node:<id>:<path>',
        )
      }
      const channel = deps.channel(route.nodeId)
      if (channel === undefined) {
        throw new Error(`remote node "${route.nodeId}" is not connected`)
      }
      return createRemoteHandle(
        channel,
        route.remotePath,
        { ...spec, argv: rewriteExecutable(spec.argv, remoteRipgrep) },
      )
    },

    async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
      const route = classifyPath(spec.cwd, undefined, deps.anchors())
      if (route.kind === 'local') return deps.localProc.spawnTerminal(spec)
      if (route.kind === 'ambiguous') {
        throw new Error(
          `"${route.remotePath}" belongs to more than one node (${route.nodeIds.join(', ')}); `
          + 'address it as node:<id>:<path>',
        )
      }
      const channel = deps.channel(route.nodeId)
      if (channel === undefined) {
        throw new Error(`remote node "${route.nodeId}" is not connected`)
      }
      return createRemoteTerminal(channel, route.remotePath, spec)
    },
  }
}
