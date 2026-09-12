/**
 * The release resolver is where a machine's platform becomes bytes that will
 * be executed there, so its cases are about the two ways that can go wrong:
 * naming an asset no release carries, and accepting bytes whose hash does not
 * match the release's own sums file.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentAssetName, agentReleaseBase, resolveAgentBinary } from '../../src/agent/release.ts'

const VERSION = '0.0.1'
const ASSET = 'dsh-remote-agent-linux-x86_64'
const BINARY = Buffer.from('the binary bytes')

/** A fresh cache directory for one case. */
async function cacheDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'drw-release-'))
}

/** A checksum line for one asset. */
function sumsFor(asset: string, digest: string): Buffer {
  return Buffer.from(`${digest}  ${asset}\n`)
}

test('each reported platform maps to its release asset', () => {
  assert.equal(agentAssetName('Linux', 'x86_64'), 'dsh-remote-agent-linux-x86_64')
  assert.equal(agentAssetName('linux', 'amd64'), 'dsh-remote-agent-linux-x86_64')
  assert.equal(agentAssetName('Darwin', 'aarch64'), 'dsh-remote-agent-darwin-aarch64')
  assert.equal(agentAssetName('darwin', 'arm64'), 'dsh-remote-agent-darwin-aarch64')
  assert.equal(agentAssetName(' Linux ', ' AMD64 '), 'dsh-remote-agent-linux-x86_64')
})

test('a platform with no release fails naming what the machine reported', () => {
  assert.throws(() => agentAssetName('FreeBSD', 'x86_64'), /FreeBSD/)
  assert.throws(() => agentAssetName('Linux', 'riscv64'), /riscv64/)
})

test('the release base is the versioned download directory', () => {
  assert.equal(
    agentReleaseBase('0.0.1'),
    'https://github.com/lengmoXXL/dsh-remote-ssh-worktree/releases/download/v0.0.1',
  )
})

test('a cached binary is returned without touching the network', async () => {
  const dir = await cacheDir()
  try {
    await mkdir(join(dir, VERSION), { recursive: true })
    await writeFile(join(dir, VERSION, ASSET), BINARY)
    const result = await resolveAgentBinary({
      version: VERSION,
      assetName: ASSET,
      cacheDir: dir,
      fetch: () => Promise.reject(new Error('the cache must short-circuit the download')),
    })
    assert.deepEqual(result, BINARY)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a verified download is returned and cached at the versioned path', async () => {
  const dir = await cacheDir()
  try {
    const digest = createHash('sha256').update(BINARY).digest('hex')
    const seen: string[] = []
    const result = await resolveAgentBinary({
      version: VERSION,
      assetName: ASSET,
      cacheDir: dir,
      fetch: (url) => {
        seen.push(url)
        return Promise.resolve(url.endsWith('SHA256SUMS') ? sumsFor(ASSET, digest) : BINARY)
      },
    })

    const base = agentReleaseBase(VERSION)
    assert.deepEqual(result, BINARY)
    assert.deepEqual([...seen].sort(), [`${base}/${ASSET}`, `${base}/SHA256SUMS`].sort())
    assert.deepEqual(await readFile(join(dir, VERSION, ASSET)), BINARY)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a checksum mismatch refuses the bytes and names the URL', async () => {
  const dir = await cacheDir()
  try {
    const wrong = createHash('sha256').update('something else').digest('hex')
    const url = `${agentReleaseBase(VERSION)}/${ASSET}`
    await assert.rejects(
      () => resolveAgentBinary({
        version: VERSION,
        assetName: ASSET,
        cacheDir: dir,
        fetch: (requested) => Promise.resolve(
          requested.endsWith('SHA256SUMS') ? sumsFor(ASSET, wrong) : BINARY,
        ),
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /SHA-256 check/)
        assert.equal(message.includes(url), true)
        return true
      },
    )
    // A refused download must leave no cache entry behind.
    await assert.rejects(() => readFile(join(dir, VERSION, ASSET)), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed download names the URL it could not read', async () => {
  const dir = await cacheDir()
  try {
    const url = `${agentReleaseBase(VERSION)}/${ASSET}`
    await assert.rejects(
      () => resolveAgentBinary({
        version: VERSION,
        assetName: ASSET,
        cacheDir: dir,
        fetch: (requested) => {
          if (requested === url) return Promise.reject(new Error('socket hang up'))
          return Promise.resolve(sumsFor(ASSET, 'a'.repeat(64)))
        },
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.equal(message.includes(`downloading ${url} failed`), true)
        assert.match(message, /socket hang up/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a sums file that names no such asset is refused', async () => {
  const dir = await cacheDir()
  try {
    const sumsUrl = `${agentReleaseBase(VERSION)}/SHA256SUMS`
    await assert.rejects(
      () => resolveAgentBinary({
        version: VERSION,
        assetName: ASSET,
        cacheDir: dir,
        fetch: (requested) => Promise.resolve(
          requested.endsWith('SHA256SUMS')
            ? sumsFor('dsh-remote-agent-other-x86_64', 'a'.repeat(64))
            : BINARY,
        ),
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.equal(message.includes(sumsUrl), true)
        assert.equal(message.includes(ASSET), true)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
