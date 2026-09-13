/**
 * The release resolver is where a machine's platform becomes bytes that will
 * be executed there, so its cases are about the ways that can go wrong: naming
 * an asset no release carries, accepting bytes whose hash does not match the
 * release's own sums file, and reading the release through an endpoint that
 * answers with something else.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentFetcher } from '../../src/remote/agent/release.ts'
import { agentAssetName, agentReleaseApi, resolveAgentBinary } from '../../src/remote/agent/release.ts'

const VERSION = '0.0.1'
const ASSET = 'dsh-remote-agent-linux-x86_64'
const BINARY = Buffer.from('the binary bytes')
const RELEASE_URL = agentReleaseApi(VERSION)

/** One request a scripted fetcher answered. */
interface SeenRequest {
  readonly url: string
  readonly accept: string
}

/** A fresh cache directory for one case. */
async function cacheDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'drw-release-'))
}

/** A checksum line for one asset. */
function sumsFor(asset: string, digest: string): Buffer {
  return Buffer.from(`${digest}  ${asset}\n`)
}

/** The digest of the fixture binary. */
function binaryDigest(): string {
  return createHash('sha256').update(BINARY).digest('hex')
}

/** Where a fake release serves one asset's bytes. */
function assetApi(name: string): string {
  return `https://api.github.com/repos/lengmoXXL/dsh-workspace/releases/assets/${name}`
}

/** Where a person would download one asset from. */
function assetBrowser(name: string): string {
  return `https://github.com/lengmoXXL/dsh-workspace/releases/download/v${VERSION}/${name}`
}

/** A release metadata body naming the given assets. */
function releaseBody(names: readonly string[]): Buffer {
  return Buffer.from(JSON.stringify({
    tag_name: `v${VERSION}`,
    assets: names.map(name => ({
      name,
      url: assetApi(name),
      browser_download_url: assetBrowser(name),
    })),
  }))
}

/**
 * A scripted fetcher: the release metadata, then whichever asset bytes the
 * caller supplies.
 * @param bodies - per-asset bodies; an absent entry fails the request.
 * @returns the fetcher and the requests it saw.
 */
function scriptedFetch(bodies: Readonly<Record<string, Buffer | undefined>>): {
  fetch: AgentFetcher
  seen: SeenRequest[]
} {
  const seen: SeenRequest[] = []
  return {
    seen,
    fetch: (url, accept) => {
      seen.push({ url, accept })
      if (url === RELEASE_URL) {
        const names = Object.keys(bodies).filter(name => bodies[name] !== undefined)
        return Promise.resolve(releaseBody(names))
      }
      for (const [name, body] of Object.entries(bodies)) {
        if (url === assetApi(name) && body !== undefined) return Promise.resolve(body)
      }
      return Promise.reject(new Error(`unscripted request to ${url}`))
    },
  }
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

test('a version is read from the release the tag names', () => {
  assert.equal(
    agentReleaseApi('0.0.1'),
    'https://api.github.com/repos/lengmoXXL/dsh-workspace/releases/tags/v0.0.1',
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
    const { fetch, seen } = scriptedFetch({
      [ASSET]: BINARY,
      SHA256SUMS: sumsFor(ASSET, binaryDigest()),
    })
    const result = await resolveAgentBinary({ version: VERSION, assetName: ASSET, cacheDir: dir, fetch })

    assert.deepEqual(result, BINARY)
    assert.deepEqual(await readFile(join(dir, VERSION, ASSET)), BINARY)
    // The release metadata is asked for as JSON, and both assets as bytes.
    assert.deepEqual(seen, [
      { url: RELEASE_URL, accept: 'application/vnd.github+json' },
      { url: assetApi(ASSET), accept: 'application/octet-stream' },
      { url: assetApi('SHA256SUMS'), accept: 'application/octet-stream' },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a release that carries no such asset is refused before anything is downloaded', async () => {
  const dir = await cacheDir()
  try {
    const { fetch, seen } = scriptedFetch({ 'dsh-remote-agent-other-x86_64': BINARY })
    await assert.rejects(
      () => resolveAgentBinary({ version: VERSION, assetName: ASSET, cacheDir: dir, fetch }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.equal(message.includes(RELEASE_URL), true)
        assert.equal(message.includes(ASSET), true)
        return true
      },
    )
    assert.deepEqual(seen.map(request => request.url), [RELEASE_URL])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports whether the bytes come from the cache or the network', async () => {
  const dir = await cacheDir()
  try {
    const sources: string[] = []
    const { fetch } = scriptedFetch({ [ASSET]: BINARY, SHA256SUMS: sumsFor(ASSET, binaryDigest()) })
    await resolveAgentBinary({
      version: VERSION,
      assetName: ASSET,
      cacheDir: dir,
      fetch,
      onSource: source => { sources.push(source) },
    })
    // The second call is answered from the cache, so it must not reach the
    // network at all — which is exactly what a caller showing progress wants
    // to be able to say.
    await resolveAgentBinary({
      version: VERSION,
      assetName: ASSET,
      cacheDir: dir,
      fetch: () => Promise.reject(new Error('the cache must short-circuit the download')),
      onSource: source => { sources.push(source) },
    })
    assert.deepEqual(sources, ['network', 'cache'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a checksum mismatch refuses the bytes and names the download', async () => {
  const dir = await cacheDir()
  try {
    const wrong = createHash('sha256').update('something else').digest('hex')
    const { fetch } = scriptedFetch({ [ASSET]: BINARY, SHA256SUMS: sumsFor(ASSET, wrong) })
    await assert.rejects(
      () => resolveAgentBinary({ version: VERSION, assetName: ASSET, cacheDir: dir, fetch }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /SHA-256 check/)
        assert.equal(message.includes(assetBrowser(ASSET)), true)
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
    const sumsUrl = assetApi('SHA256SUMS')
    await assert.rejects(
      () => resolveAgentBinary({
        version: VERSION,
        assetName: ASSET,
        cacheDir: dir,
        fetch: (url) => {
          if (url === sumsUrl) return Promise.reject(new Error('socket hang up'))
          if (url === RELEASE_URL) return Promise.resolve(releaseBody([ASSET, 'SHA256SUMS']))
          return Promise.resolve(BINARY)
        },
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.equal(message.includes(`downloading ${sumsUrl} failed`), true)
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
    const { fetch } = scriptedFetch({
      [ASSET]: BINARY,
      SHA256SUMS: sumsFor('dsh-remote-agent-other-x86_64', 'a'.repeat(64)),
    })
    await assert.rejects(
      () => resolveAgentBinary({ version: VERSION, assetName: ASSET, cacheDir: dir, fetch }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.equal(message.includes(assetBrowser('SHA256SUMS')), true)
        assert.equal(message.includes(ASSET), true)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an answer that is not release JSON is refused by name', async () => {
  const dir = await cacheDir()
  try {
    await assert.rejects(
      () => resolveAgentBinary({
        version: VERSION,
        assetName: ASSET,
        cacheDir: dir,
        fetch: () => Promise.resolve(Buffer.from('<html>not found</html>')),
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.equal(message.includes(`${RELEASE_URL} did not answer with release JSON`), true)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
