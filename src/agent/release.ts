/**
 * Resolve the agent binary for one machine's platform.
 *
 * The agent is a static Rust binary published on GitHub Releases, so "install
 * the agent" reduces to naming the right asset for `uname` and caching its
 * bytes on the host. The cache is keyed by version and asset, which is what
 * makes a version bump a fresh download and a second machine of the same
 * platform a cache hit.
 *
 * Every download is verified against the release's `SHA256SUMS` before it is
 * cached: the bytes are executed on a remote machine, so a truncated or
 * substituted asset must fail here rather than at exec time there.
 *
 * @module dsh-remote-ssh-worktree/agent/release
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Repository whose releases carry the agent binaries. */
const RELEASE_REPOSITORY = 'https://github.com/lengmoXXL/dsh-remote-ssh-worktree'

/** Platform names `uname -s` reports, and the asset token each maps to. */
const PLATFORMS: Readonly<Record<string, string>> = {
  linux: 'linux',
  darwin: 'darwin',
}

/** Architecture names `uname -m` reports, and the asset token each maps to. */
const ARCHITECTURES: Readonly<Record<string, string>> = {
  x86_64: 'x86_64',
  amd64: 'x86_64',
  aarch64: 'aarch64',
  arm64: 'aarch64',
}

/** Options {@link resolveAgentBinary} reads. */
export interface AgentBinaryOptions {
  /** Agent build to fetch, e.g. `0.0.1`. */
  readonly version: string
  /** Release asset for the machine's platform, from {@link agentAssetName}. */
  readonly assetName: string
  /** Host directory the binary cache lives under. */
  readonly cacheDir: string
  /** Downloads one URL; injectable so tests need no network. */
  readonly fetch?: (url: string) => Promise<Buffer>
}

/**
 * Name the release asset for a machine's reported platform.
 *
 * Matching is case-insensitive because `uname` casing is not portable, and
 * both the GNU and the BSD spelling of each architecture is accepted so the
 * plugin never depends on which userland `uname` came from.
 * @param platform - `uname -s` output, e.g. `Linux`.
 * @param arch - `uname -m` output, e.g. `x86_64`.
 * @returns the release asset name.
 * @throws when the machine reports a platform or architecture with no asset.
 */
export function agentAssetName(platform: string, arch: string): string {
  const os = PLATFORMS[platform.trim().toLowerCase()]
  const cpu = ARCHITECTURES[arch.trim().toLowerCase()]
  if (os === undefined || cpu === undefined) {
    throw new Error(
      `the machine reports platform "${platform.trim()}" and architecture "${arch.trim()}", `
      + 'which has no dsh-remote-agent release; it ships for Linux and Darwin on x86_64 and aarch64',
    )
  }
  return `dsh-remote-agent-${os}-${cpu}`
}

/**
 * The release directory one agent version's assets live under.
 * @param version - the agent build.
 * @returns the base URL an asset name and `SHA256SUMS` are appended to.
 */
export function agentReleaseBase(version: string): string {
  return `${RELEASE_REPOSITORY}/releases/download/v${version}`
}

/** Download one URL, or fail with a message that names it. */
async function download(fetchBinary: (url: string) => Promise<Buffer>, url: string): Promise<Buffer> {
  try {
    return await fetchBinary(url)
  } catch (error) {
    throw new Error(
      `downloading ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

/** The real HTTPS GET, refusing any non-2xx answer. */
async function fetchOverHttps(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Read the expected hash for one asset out of a `SHA256SUMS` body.
 * @param sums - the decoded sums file.
 * @param assetName - the asset to look up.
 * @param sumsUrl - the URL the sums came from, for the diagnostic.
 * @returns the expected lowercase hex digest.
 * @throws when the sums file names no such asset.
 */
function expectedChecksum(sums: string, assetName: string, sumsUrl: string): string {
  for (const line of sums.split('\n')) {
    // `<hex>␠␠<name>` is the format; a `*` marks binary mode in some tools.
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (match !== null && match[2]?.trim() === assetName) return match[1]!.toLowerCase()
  }
  throw new Error(`${sumsUrl} names no "${assetName}"`)
}

/**
 * Fetch, verify, and cache one agent binary.
 *
 * A cached file is returned untouched: it was verified when it was written,
 * and re-hashing every connect would spend a slow link's budget on a file the
 * plugin itself produced.
 * @param options - version, asset, cache directory, and an optional fetch.
 * @returns the verified binary bytes.
 * @throws when the download fails, the checksum mismatches, or the cache
 *   cannot be written.
 */
export async function resolveAgentBinary(options: AgentBinaryOptions): Promise<Buffer> {
  const fetchBinary = options.fetch ?? fetchOverHttps
  const cached = join(options.cacheDir, options.version, options.assetName)
  try {
    return await readFile(cached)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const base = agentReleaseBase(options.version)
  const binaryUrl = `${base}/${options.assetName}`
  const sumsUrl = `${base}/SHA256SUMS`
  const [binary, sums] = await Promise.all([
    download(fetchBinary, binaryUrl),
    download(fetchBinary, sumsUrl),
  ])
  const expected = expectedChecksum(sums.toString('utf8'), options.assetName, sumsUrl)
  const actual = createHash('sha256').update(binary).digest('hex')
  if (actual !== expected) {
    throw new Error(
      `the download from ${binaryUrl} failed its SHA-256 check: expected ${expected}, got ${actual}`,
    )
  }

  // A reader of the cache must never observe a partial download, so the bytes
  // land on a private temp path and are renamed into place in one step. The
  // executable bit is set here because the file is copied verbatim to the
  // machine without a second local chmod.
  await mkdir(dirname(cached), { recursive: true, mode: 0o700 })
  const temp = `${cached}.${String(process.pid)}.${randomUUID()}`
  try {
    await writeFile(temp, binary, { mode: 0o755 })
    await rename(temp, cached)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  return binary
}
