/**
 * Atomic text publication.
 *
 * A write stages the complete new content in a uniquely named sibling file and
 * publishes it with a single filesystem operation, so a reader never observes a
 * partial file and a failed write leaves the previous content in place.
 *
 * @module dsh-remote-agent/atomic
 */

import { randomUUID } from 'node:crypto'
import { link, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** How a staged file is published, and with which permissions. */
export interface PublishOptions {
  /**
   * Publish through a hard link so an existing destination is preserved and
   * this call rejects with `EEXIST` instead of overwriting it.
   */
  readonly createIfAbsent: boolean
  /**
   * POSIX mode to apply to the published file before publication, or
   * `undefined` to keep the process default (umask applied). Callers pass the
   * replaced file's mode so a write does not narrow its permissions.
   */
  readonly mode: number | undefined
}

/**
 * Publish `content` at `targetPath` in one atomic step.
 *
 * Missing parent directories are created. The staged file is removed on every
 * outcome, successful or not. `createIfAbsent` publishes through `link(2)`, so
 * a concurrent creator keeps its file and this call fails with `EEXIST`;
 * otherwise `rename(2)` replaces the destination. A symlink at `targetPath` is
 * replaced rather than followed, which is why callers pass canonical paths.
 *
 * @param targetPath - absolute destination path.
 * @param content - complete UTF-8 text to publish.
 * @param options - publication mode and the destination mode to preserve.
 * @throws NodeJS.ErrnoException from the underlying filesystem call; `EEXIST`
 *   means `createIfAbsent` found the destination present.
 */
export async function publishText(
  targetPath: string,
  content: string,
  options: PublishOptions,
): Promise<void> {
  const directory = dirname(targetPath)
  await mkdir(directory, { recursive: true })
  const stagingPath = join(directory, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const handle = await open(stagingPath, 'wx', 0o666)
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
      if (options.mode !== undefined) await handle.chmod(options.mode)
    } finally {
      await handle.close()
    }
    if (options.createIfAbsent) {
      await link(stagingPath, targetPath)
    } else {
      await rename(stagingPath, targetPath)
    }
  } finally {
    try {
      await rm(stagingPath, { force: true })
    } catch {
      // A leftover staging file is the lesser failure: the primary error is
      // already unwinding, the name is unique per call, and the file is inert.
    }
  }
}
