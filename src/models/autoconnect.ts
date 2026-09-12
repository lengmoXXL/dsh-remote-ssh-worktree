/**
 * Bring every configured machine up once, when the plugin loads.
 *
 * Nothing connects on an operation's behalf: a machine is reachable because it
 * was connected, not because a file read happened to need it. Without this pass
 * a deployment would sit with every machine idle until a person opened the
 * section and clicked Connect — and a restored session would find its workspace
 * unreachable.
 *
 * One machine gets a few attempts in a row, because a failure right after
 * startup is often a machine still booting or an agent still starting. After
 * those, this stops for that machine: it stays failed with the error the last
 * attempt recorded, and only a person asks again.
 *
 * The pass runs in the background and never rejects. Activation must not wait
 * for SSH, and a machine that cannot be reached is a state the section renders,
 * not a failure of the plugin.
 *
 * @module dsh-remote-ssh-worktree/models/autoconnect
 */

import type { NodeConnections } from './machines.ts'
import type { NodeRecord } from '../storage/nodes.ts'

/** How many times one machine is attempted before this pass gives up on it. */
const ATTEMPTS = 3

/** Gap between those attempts, in milliseconds. */
const RETRY_GAP_MS = 2_000

/** What one pass needs. */
export interface AutoconnectDeps {
  /** Every configured machine, read once when the pass starts. */
  readonly records: () => readonly NodeRecord[]
  /** The connection manager that owns the attempts. */
  readonly connections: Pick<NodeConnections, 'connect'>
  /** Attempts per machine; defaults to {@link ATTEMPTS}. */
  readonly attempts?: number
  /** Gap between attempts; defaults to {@link RETRY_GAP_MS}. */
  readonly gapMs?: number
  /** Sleeps between attempts; injectable so tests do not wait. */
  readonly delay?: (ms: number) => Promise<void>
}

/**
 * Start one background attempt pass over every configured machine.
 * @param deps - the machines, the connection manager, and the retry knobs.
 * @returns a function that stops the pass; an attempt already in flight is left
 *   to finish or fail on its own, and no further attempt starts.
 */
export function autoconnect(deps: AutoconnectDeps): () => void {
  const attempts = deps.attempts ?? ATTEMPTS
  const gapMs = deps.gapMs ?? RETRY_GAP_MS
  const delay = deps.delay ?? ((ms: number): Promise<void> =>
    new Promise(resolve => { setTimeout(resolve, ms) }))
  let stopped = false

  /** Attempt one machine until it connects, the attempts run out, or this stops. */
  const pass = async (record: NodeRecord): Promise<void> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (stopped) return
      if (attempt > 0) await delay(gapMs)
      if (stopped) return
      try {
        await deps.connections.connect(record)
        return
      } catch {
        // The attempt recorded its own failure on the machine's status; the
        // only thing left to try is the next attempt.
      }
    }
  }

  for (const record of deps.records()) void pass(record)
  return () => { stopped = true }
}
