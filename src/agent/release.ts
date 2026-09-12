/**
 * Resolve the agent binary for one machine's platform.
 *
 * The agent is a static Rust binary published on GitHub Releases, so "install
 * the agent" reduces to naming the right asset for `uname` and caching its
 * bytes on the host. The cache is keyed by version and asset, which is what
 * makes a version bump a fresh download and a second machine of the same
 * platform a cache hit.
 *
 * Assets are read through the GitHub API rather than the address a browser
 * would use. The API is what `gh` itself downloads through, it serves a public
 * repository anonymously, it answers with the release's own asset list — so a
 * missing asset is a named error instead of an HTML error page — and it is the
 * endpoint that stays reachable on networks which drop the web host. Anonymous
 * reads are rate-limited, which the version-keyed cache keeps to one release
 * lookup and two asset reads per version and host. A private repository would
 * refuse an anonymous read; this build reads public releases.
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
const RELEASE_REPOSITORY = 'lengmoXXL/dsh-remote-ssh-worktree'

/** The release API root every request below hangs off. */
const API_ROOT = `https://api.github.com/repos/${RELEASE_REPOSITORY}`

/** Media type the release metadata is requested as. */
const RELEASE_MEDIA_TYPE = 'application/vnd.github+json'

/** Media type an asset's bytes are requested as. */
const BINARY_MEDIA_TYPE = 'application/octet-stream'

/** Pinned API revision, so a GitHub change cannot alter what this parses. */
const API_VERSION = '2022-11-28'

/** The sums asset every release carries beside its binaries. */
const SUMS_ASSET = 'SHA256SUMS'

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

/** Downloads one URL, asking for one media type; injectable so tests need no network. */
export type AgentFetcher = (url: string, accept: string) => Promise<Buffer>

/** Options {@link resolveAgentBinary} reads. */
export interface AgentBinaryOptions {
  /** Agent build to fetch, e.g. `0.0.1`. */
  readonly version: string
  /** Release asset for the machine's platform, from {@link agentAssetName}. */
  readonly assetName: string
  /** Host directory the binary cache lives under. */
  readonly cacheDir: string
  /** Downloads one URL; injectable so tests need no network. */
  readonly fetch?: AgentFetcher
  /**
   * Reports where the bytes come from, before any network read.
   *
   * A cache hit and a download look identical from the outside and take very
   * different amounts of time, so a caller that shows progress needs to tell
   * them apart.
   */
  readonly onSource?: (source: 'cache' | 'network') => void
}

/** One asset of a release, as much of it as this module uses. */
interface ReleaseAsset {
  /** Asset name, e.g. `dsh-remote-agent-linux-x86_64`. */
  readonly name: string
  /** API URL whose bytes the plugin downloads. */
  readonly apiUrl: string
  /** Browser URL for the same bytes, used only in diagnostics. */
  readonly browserUrl: string
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
 * The release API URL one agent version's metadata lives at.
 * @param version - the agent build.
 * @returns the URL the asset list is read from.
 */
export function agentReleaseApi(version: string): string {
  return `${API_ROOT}/releases/tags/v${version}`
}

/** Download one URL, or fail with a message that names it. */
async function download(fetcher: AgentFetcher, url: string, accept: string): Promise<Buffer> {
  try {
    return await fetcher(url, accept)
  } catch (error) {
    throw new Error(
      `downloading ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

/** The real HTTPS GET, refusing any non-2xx answer. */
async function fetchOverHttps(url: string, accept: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { accept, 'X-GitHub-Api-Version': API_VERSION },
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Read the assets one release metadata answer names.
 * @param release - the release API response body.
 * @param releaseUrl - the URL it came from, for the diagnostic.
 * @returns the usable assets.
 * @throws when the answer is not release JSON.
 */
function releaseAssets(release: Buffer, releaseUrl: string): readonly ReleaseAsset[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(release.toString('utf8'))
  } catch {
    throw new Error(`${releaseUrl} did not answer with release JSON`)
  }
  const assets = (parsed as { assets?: unknown }).assets
  if (!Array.isArray(assets)) throw new Error(`${releaseUrl} did not answer with a release`)
  return assets.flatMap(asset => {
    const record = asset as { name?: unknown; url?: unknown; browser_download_url?: unknown }
    if (typeof record.name !== 'string' || typeof record.url !== 'string') return []
    return [{
      name: record.name,
      apiUrl: record.url,
      browserUrl: typeof record.browser_download_url === 'string' ? record.browser_download_url : record.url,
    }]
  })
}

/**
 * The asset one release carries under a name.
 * @param release - the release API response body.
 * @param releaseUrl - the URL it came from, for the diagnostic.
 * @param name - the asset name to find.
 * @returns the asset.
 * @throws when the release carries no such asset.
 */
function requireAsset(release: Buffer, releaseUrl: string, name: string): ReleaseAsset {
  const found = releaseAssets(release, releaseUrl).find(asset => asset.name === name)
  if (found === undefined) throw new Error(`${releaseUrl} names no "${name}" asset`)
  return found
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
 * @throws when the release cannot be read, carries no such asset, the download
 *   fails, the checksum mismatches, or the cache cannot be written.
 */
export async function resolveAgentBinary(options: AgentBinaryOptions): Promise<Buffer> {
  const fetcher = options.fetch ?? fetchOverHttps
  const cached = join(options.cacheDir, options.version, options.assetName)
  try {
    const bytes = await readFile(cached)
    options.onSource?.('cache')
    return bytes
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  options.onSource?.('network')
  const releaseUrl = agentReleaseApi(options.version)
  const release = await download(fetcher, releaseUrl, RELEASE_MEDIA_TYPE)
  const binaryAsset = requireAsset(release, releaseUrl, options.assetName)
  const sumsAsset = requireAsset(release, releaseUrl, SUMS_ASSET)
  const [binary, sums] = await Promise.all([
    download(fetcher, binaryAsset.apiUrl, BINARY_MEDIA_TYPE),
    download(fetcher, sumsAsset.apiUrl, BINARY_MEDIA_TYPE),
  ])
  const expected = expectedChecksum(sums.toString('utf8'), options.assetName, sumsAsset.browserUrl)
  const actual = createHash('sha256').update(binary).digest('hex')
  if (actual !== expected) {
    throw new Error(
      `the download from ${binaryAsset.browserUrl} failed its SHA-256 check: expected ${expected}, got ${actual}`,
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
