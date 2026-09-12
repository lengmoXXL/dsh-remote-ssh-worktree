/**
 * The process primitives both execution backends share.
 *
 * The subprocess and terminal backends start children the same way and report
 * their failures with the same vocabulary, so the bounded output window, the
 * scrubbed environment, the working-directory check, and the failure type live
 * here rather than inside either backend.
 *
 * @module dsh-remote-agent/execution
 */

import { createWriteStream } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {
  SpPipeFrame,
  WireCollect,
  WireOutputRead,
  WireSubprocessErrorCode,
} from '../../shared/protocol.ts'

/**
 * Deliver one pipe frame to the connection that owns the process.
 *
 * The returned promise settles when the frame has been written, which is what
 * lets the backend bound how much unread output it retains.
 */
export type PipeFrameSender = (frame: SpPipeFrame) => Promise<void>
/** Credential-shaped environment names, matching the subprocess seam's scrub. */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** The harness-reserved environment namespace, matched case-insensitively. */
const DSH_ENV_PREFIX = 'DSH_'

/** A subprocess operation failure carrying the protocol's own stable code. */
export class SubprocessFailure extends Error {
  /** The wire code the plugin rethrows unchanged. */
  readonly code: WireSubprocessErrorCode

  /**
   * @param code - the wire code the plugin rethrows unchanged.
   * @param message - human-readable detail the plugin logs but does not parse.
   * @param options - optional underlying cause.
   */
  constructor(code: WireSubprocessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SubprocessFailure'
    this.code = code
  }
}
/**
 * Bounded in-memory tail of one collected stream, with its optional spill file.
 *
 * Offsets are whole-stream byte coordinates, so a read consumes nothing and two
 * readers asking from the same offset see the same bytes. Callers that collect
 * terminal output use the same window with spilling disabled.
 */
export class StreamBuffer {
  private readonly chunks: Buffer[] = []
  private readonly maxBytes: number
  private readonly spillMaxBytes: number | undefined
  private readonly spillPath: string | undefined
  private spill: WriteStream | undefined
  private retained = 0
  private dropped = 0
  private total = 0
  private spilled = 0
  private spillBroken = false

  /**
   * @param collect - the caller's byte caps.
   * @param spillPath - where the whole stream is mirrored, when spilling is on.
   */
  constructor(collect: WireCollect, spillPath: string | undefined) {
    this.maxBytes = collect.maxBytes
    this.spillMaxBytes = collect.spillMaxBytes
    this.spillPath = spillPath
  }

  /**
   * Append captured bytes, keeping only the last `maxBytes` of them.
   * @param chunk - the bytes one read produced.
   */
  push(chunk: Buffer): void {
    this.total += chunk.length
    this.writeSpill(chunk)
    this.chunks.push(chunk)
    this.retained += chunk.length
    while (this.retained > this.maxBytes) {
      const head = this.chunks[0]
      if (head === undefined) break
      const excess = this.retained - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.retained -= head.length
        this.dropped += head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.retained -= excess
        this.dropped += excess
      }
    }
  }

  /**
   * Read the retained window from a whole-stream offset.
   * @param fromByte - the offset to read from.
   * @returns the bytes from there, the resume offset, and whether the offset
   *   had already been dropped from the window.
   */
  read(fromByte: number): WireOutputRead {
    const lossy = fromByte < this.dropped
    const skip = lossy ? 0 : Math.min(fromByte - this.dropped, this.retained)
    const bytes = Buffer.concat(this.chunks, this.retained).subarray(skip)
    return { data: bytes.toString('base64'), nextOffset: this.total, lossy }
  }

  /** Close and remove the spill file. */
  dispose(): void {
    this.spill?.end()
    this.spill = undefined
    if (this.spillPath !== undefined) {
      void rm(this.spillPath, { force: true }).catch(() => {
        // A leftover spill file is inert; the connection is already gone.
      })
    }
  }

  /** Mirror the whole stream into the spill file until its cap is exceeded. */
  private writeSpill(chunk: Buffer): void {
    if (this.spillMaxBytes === undefined || this.spillBroken || this.spillPath === undefined) return
    if (this.spilled + chunk.length > this.spillMaxBytes) {
      // The spill can no longer be complete, so it is discarded rather than
      // published as a truncated stream.
      this.spillBroken = true
      this.spill?.destroy()
      this.spill = undefined
      // Best effort: the spill file is already unreachable, and a removal that
      // fails leaves only a file the machine's own cleanup will collect.
      void rm(this.spillPath, { force: true }).catch(() => {})
      return
    }
    if (this.spill === undefined) {
      const stream = createWriteStream(this.spillPath, { flags: 'w' })
      stream.on('error', () => { this.spillBroken = true })
      this.spill = stream
    }
    this.spill.write(chunk)
    this.spilled += chunk.length
  }
}
/**
 * The environment a child starts from: the daemon's own, minus credential-shaped
 * names and every `DSH_*` name.
 * @returns a fresh environment object the caller may extend with its own overrides.
 */
export function scrubbedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    if (key.toUpperCase().startsWith(DSH_ENV_PREFIX)) continue
    environment[key] = value
  }
  return environment
}
/**
 * The canonical working directory a launch starts in, or the typed failure
 * that refuses it.
 * @param cwd - the caller's working directory.
 * @param code - the failure code the calling family uses.
 * @returns the realpath-normalized directory.
 * @throws SubprocessFailure `code` when the path is relative, missing, or not
 *   a directory.
 */
export async function usableDirectory(cwd: string, code: WireSubprocessErrorCode): Promise<string> {
  if (!isAbsolute(cwd)) {
    throw new SubprocessFailure(code, `cannot start in "${cwd}": the working directory is not absolute`)
  }
  try {
    const info = await stat(cwd)
    if (!info.isDirectory()) {
      throw new SubprocessFailure(code, `cannot start in "${cwd}": not a directory`)
    }
    return await realpath(cwd)
  } catch (error: unknown) {
    if (error instanceof SubprocessFailure) throw error
    throw new SubprocessFailure(code, `cannot start in "${cwd}": ${describe(error)}`, { cause: error })
  }
}

/** Render one thrown value for a failure message. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
