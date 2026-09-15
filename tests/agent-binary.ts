/**
 * Where the compiled remote agent lives.
 *
 * The agent is a Rust binary installed from a GitHub Release, so a suite that
 * needs a real daemon builds it first (`npm run build:agent`) or points
 * `DSH_REMOTE_AGENT_BIN` at a binary it already has.
 *
 * @module tests/agent-binary
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The repository root, one level above this file's directory. */
const repoRoot = join(here, '..')

/** Candidates in the order they win: an explicit override, then a release or debug build. */
function candidates(): readonly string[] {
  const override = process.env['DSH_REMOTE_AGENT_BIN']
  return [
    ...override === undefined || override === '' ? [] : [override],
    join(repoRoot, 'agent', 'target', 'release', 'dsh-remote-agent'),
    join(repoRoot, 'agent', 'target', 'debug', 'dsh-remote-agent'),
  ]
}

/**
 * Resolve the compiled agent binary.
 * @returns its absolute path.
 * @throws when no build is present.
 */
export function agentBinaryPath(): string {
  const found = candidates().find(path => existsSync(path))
  if (found === undefined) {
    throw new Error('the remote agent is not built; run `npm run build:agent` or set DSH_REMOTE_AGENT_BIN')
  }
  return found
}
