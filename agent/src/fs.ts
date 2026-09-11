/**
 * The filesystem operations behind the daemon's `fs.*` wire methods.
 *
 * Every method addresses an absolute path. `resolve` canonicalizes a request —
 * through its deepest existing ancestor when the target does not exist yet —
 * and that canonical path is the only target identity the protocol has; the
 * daemon keeps no per-connection target state, so two connections naming the
 * same file agree on its path and on its version token.
 *
 * Guarded writes compare a version token and then publish separately; see
 * {@link ./version.ts} for the window that leaves open and why it is accepted.
 *
 * @module dsh-remote-agent/fs
 */

import { constants as bufferConstants } from 'node:buffer'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { BigIntStats, Dirent } from 'node:fs'
import { isAbsolute, basename, dirname, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import type {
  WireBytes,
  WireDirEntry,
  WireEditOutcome,
  WireEditRequest,
  WireFsErrorCode,
  WireFileType,
  WireLstat,
  WirePathType,
  WireStat,
  WireTarget,
  WireTextChunk,
  WireWriteIntent,
  WireWriteOutcome,
} from '../../shared/protocol.ts'
import { publishText } from './atomic.ts'
import { versionOf, missingVersion } from './version.ts'

/** Exclusive byte limit on the pre-write diff basis; larger files report `before: null`. */
const DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

/** Bytes per read when an editing caller needs the whole file. */
const READ_ALL_CHUNK_BYTES = 1 << 20

/** A filesystem failure carrying the protocol's own stable code. */
export class FsFailure extends Error {
  /** The wire code the plugin rethrows unchanged. */
  readonly code: WireFsErrorCode

  /**
   * @param code - the wire code the plugin rethrows unchanged.
   * @param message - human-readable detail the plugin logs but does not parse.
   * @param options - optional underlying cause.
   */
  constructor(code: WireFsErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FsFailure'
    this.code = code
  }
}

/** The filesystem methods the daemon serves, one per `fs.*` wire method. */
export interface FsBackend {
  /**
   * Canonicalize a requested path; the caller adopts the result as the target identity.
   *
   * A path that does not exist yet resolves through its deepest existing
   * ancestor, so a target can be named before it is created; `stat` is what
   * reports absence, and it keeps returning `null`.
   * @param path - absolute path, or relative to `cwd`.
   * @param cwd - absolute base for a relative `path`.
   * @returns the realpath-normalized absolute path.
   * @throws FsFailure `FS_NOT_FOUND` when a path segment is a regular file,
   *   `FS_IO_ERROR` when the path is relative and neither `cwd` nor a root can
   *   place it.
   */
  resolve(path: string, cwd: string | undefined): Promise<WireTarget>
  /**
   * Read metadata with the final symlink followed.
   * @param path - the target path.
   * @returns metadata, or `null` when the path or a parent segment is absent.
   */
  stat(path: string): Promise<WireStat | null>
  /**
   * Read metadata without following the final symlink.
   * @param path - the path entry to inspect.
   * @param cwd - absolute base for a relative `path`.
   * @returns metadata, or `null` when the entry is absent.
   */
  lstat(path: string, cwd: string | undefined): Promise<WireLstat | null>
  /**
   * List direct children with resolved targets, in stable name order, reading
   * no file contents.
   * @param path - the directory to list.
   * @returns one entry per child; a child that vanished mid-listing reports
   *   type `other` with no version.
   * @throws FsFailure `FS_NOT_FOUND` for a missing directory, `FS_NOT_DIRECTORY`
   *   for a non-directory.
   */
  listDir(path: string): Promise<readonly WireDirEntry[]>
  /**
   * Decode one UTF-8 text window.
   *
   * The window is trimmed back to a code-point boundary, so the returned text
   * never ends mid-sequence and `nextOffset` resumes the caller exactly there.
   * A start offset that splits a code point is a caller error and surfaces as
   * `FS_NOT_TEXT` from the fatal decoder.
   * @param path - the regular file to read.
   * @param offset - 0-based first byte, as returned by the previous window's `nextOffset`.
   * @param length - requested byte count; the window may be shorter at end of file.
   * @returns the decoded text, the resume offset, and whether the file ended.
   * @throws FsFailure `FS_NOT_FOUND`, `FS_NOT_REGULAR_FILE`, or `FS_NOT_TEXT`
   *   for NUL bytes and invalid UTF-8.
   */
  readTextChunk(path: string, offset: number, length: number): Promise<WireTextChunk>
  /**
   * Read a whole regular file as raw bytes.
   * @param path - the file to read.
   * @param maxBytes - inclusive cap on the complete content.
   * @returns the base64-encoded content.
   * @throws FsFailure `FS_TOO_LARGE` when the file exceeds `maxBytes`, decided
   *   from metadata before any content is buffered.
   */
  readBytes(path: string, maxBytes: number): Promise<WireBytes>
  /**
   * Read the byte window `[offset, offset + length)`.
   * @param path - the file to read.
   * @param offset - 0-based first byte; at or past the end yields empty.
   * @param length - largest byte count to return.
   * @returns the base64-encoded window.
   */
  readByteRange(path: string, offset: number, length: number): Promise<WireBytes>
  /**
   * Publish text atomically, honouring a guard when one is supplied.
   * @param path - the file to write; missing parents are created.
   * @param content - the complete text to publish, stored verbatim.
   * @param expected - the guard, or `undefined` for an unconditional write.
   * @returns the operation, the post-write version, the LF-normalized content
   *   read before the write (`null` for a create), and the LF-normalized
   *   content written.
   * @throws FsFailure `FS_NOT_OBSERVED` when `createIfAbsent` meets an existing
   *   target, `FS_STALE_VERSION` when `replaceIfVersion` meets an absent or
   *   changed target, `FS_NOT_REGULAR_FILE` for a non-file target.
   */
  writeText(path: string, content: string, expected: WireWriteIntent | undefined): Promise<WireWriteOutcome>
  /**
   * Apply a literal replacement to the current text.
   * @param path - the file to edit.
   * @param edit - the literal match and replacement.
   * @param expected - the version the caller's content came from, or `undefined`
   *   for an unconditional edit. It is checked before matching, so an edit
   *   against stale content reports `FS_STALE_VERSION` rather than a match failure.
   * @returns the post-edit version and the LF-normalized before and after text.
   * @throws FsFailure `FS_EDIT_NOT_FOUND`, `FS_AMBIGUOUS_EDIT`,
   *   `FS_STALE_VERSION`, `FS_NOT_TEXT`, `FS_NOT_REGULAR_FILE`.
   */
  editText(path: string, edit: WireEditRequest, expected: string | undefined): Promise<WireEditOutcome>
}

/**
 * Place a requested path without ever consulting the daemon's working directory.
 * @param verb - the operation named in the failure.
 * @param path - the caller's path.
 * @param base - absolute base for a relative path: the protocol's `cwd`, or the
 *   daemon's `--root`.
 * @returns the normalized absolute path.
 * @throws FsFailure `FS_IO_ERROR` when the path is relative and `base` cannot
 *   place it; a path-shape failure stays in the filesystem family even for a
 *   git method, because no git command has run yet.
 */
export function absolutePath(verb: string, path: string, base: string | undefined): string {
  if (isAbsolute(path)) return resolve(path)
  if (base === undefined || !isAbsolute(base)) {
    throw new FsFailure(
      'FS_IO_ERROR',
      `cannot ${verb} "${path}": path is relative and no absolute cwd or root is available`,
    )
  }
  return resolve(base, path)
}

/**
 * Build the filesystem backend for one daemon process.
 * @param root - absolute default base for relative paths, or `undefined` to
 *   reject them; the daemon never falls back to its own working directory.
 * @returns the backend bound to that base.
 */
export function createFsBackend(root: string | undefined): FsBackend {
  /**
   * Canonicalize a requested path.
   *
   * An existing path realpaths as a whole. A path that does not exist yet is
   * canonicalized through its deepest existing ancestor with the remaining
   * segments appended lexically, so a create flow can name its target before
   * the file exists and keeps the same identity across its creation.
   * @param verb - the operation named in failures.
   * @param path - the absolute path to canonicalize.
   * @returns the canonical absolute path.
   * @throws FsFailure `FS_NOT_FOUND` when a path segment is a regular file,
   *   `FS_IO_ERROR` for any other filesystem fault.
   */
  async function canonicalTarget(verb: string, path: string): Promise<string> {
    try {
      return await realpath(path)
    } catch (error: unknown) {
      // A regular file where a directory is required means the target can
      // never exist, whatever its final segment names.
      if (isErrno(error, 'ENOTDIR')) throw notFound(verb, path)
      if (!isErrno(error, 'ENOENT')) throw ioFailure(verb, path, error)
    }
    const missing = [basename(path)]
    let ancestor = dirname(path)
    for (;;) {
      try {
        return join(await realpath(ancestor), ...missing)
      } catch (error: unknown) {
        if (!isErrno(error, 'ENOENT', 'ENOTDIR')) throw ioFailure(verb, ancestor, error)
        const parent = dirname(ancestor)
        if (parent === ancestor) return path
        missing.unshift(basename(ancestor))
        ancestor = parent
      }
    }
  }

  /** Resolve a listed child, falling back to the parent's canonical name for an absent one. */
  async function childCanonical(verb: string, parent: string, name: string): Promise<string> {
    const candidate = join(parent, name)
    try {
      return await realpath(candidate)
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT', 'ENOTDIR')) return candidate
      throw ioFailure(verb, candidate, error)
    }
  }

  return {
    async resolve(path, cwd) {
      return { canonicalPath: await canonicalTarget('resolve', absolutePath('resolve', path, cwd ?? root)) }
    },

    async stat(path) {
      const target = absolutePath('stat', path, root)
      const info = await probe('stat', target, true)
      if (info === null) return null
      return { version: versionOf(info), type: fileType(info), size: Number(info.size) }
    },

    async lstat(path, cwd) {
      const target = absolutePath('lstat', path, cwd ?? root)
      const info = await probe('lstat', target, false)
      if (info === null) return null
      return { version: versionOf(info), type: pathType(info), size: Number(info.size) }
    },

    async listDir(path) {
      const verb = 'list'
      const target = await canonicalTarget(verb, absolutePath(verb, path, root))
      const info = await probe(verb, target, true)
      if (info === null) throw notFound(verb, target)
      if (!info.isDirectory()) {
        throw new FsFailure('FS_NOT_DIRECTORY', `cannot ${verb} "${target}": not a directory`)
      }
      let children: Dirent[]
      try {
        children = await readdir(target, { withFileTypes: true })
      } catch (error: unknown) {
        throw ioFailure(verb, target, error)
      }
      const entries: WireDirEntry[] = []
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
        const childPath = await childCanonical(verb, target, child.name)
        const childInfo = await probe(verb, childPath, true)
        entries.push({
          name: child.name,
          type: childInfo === null ? 'other' : fileType(childInfo),
          target: { canonicalPath: childPath },
          ...childInfo === null ? {} : { version: versionOf(childInfo) },
          ...childInfo !== null && childInfo.isFile() ? { size: Number(childInfo.size) } : {},
        })
      }
      return entries
    },

    async readTextChunk(path, offset, length) {
      const verb = 'read'
      const target = absolutePath(verb, path, root)
      const info = await probe(verb, target, true)
      if (info === null) throw notFound(verb, target)
      if (!info.isFile()) throw notRegularFile(verb, target)
      const size = Number(info.size)
      if (offset >= size) return { text: '', nextOffset: offset, eof: true }
      // Hold back a fragment smaller than one code point so the decoder always
      // sees whole sequences; widening to four bytes keeps a short window from
      // consisting of nothing but that fragment.
      const wanted = Math.min(Math.max(length, 4), size - offset)
      const window = await readWindow(verb, target, offset, wanted)
      const fragment = trailingFragmentLength(window)
      if (fragment > 0 && offset + window.length >= size) {
        // The fragment runs into the end of the file, so no later window can
        // complete it: the file is not valid UTF-8.
        throw new FsFailure('FS_NOT_TEXT', `cannot ${verb} "${target}": invalid UTF-8 text`)
      }
      const usable = fragment > 0 && fragment < window.length ? window.subarray(0, window.length - fragment) : window
      const nextOffset = offset + usable.length
      return { text: decodeText(verb, target, usable), nextOffset, eof: nextOffset >= size }
    },

    async readBytes(path, maxBytes) {
      const verb = 'read'
      const target = absolutePath(verb, path, root)
      const info = await probe(verb, target, true)
      if (info === null) throw notFound(verb, target)
      if (!info.isFile()) throw notRegularFile(verb, target)
      const size = Number(info.size)
      if (size > maxBytes) throw tooLarge(verb, target, `${size} bytes exceeds the ${maxBytes}-byte limit`)
      // One byte past the cap detects growth after the stat without buffering
      // an unbounded amount of content.
      const bytes = await readWindow(verb, target, 0, Math.min(size + 1, maxBytes + 1))
      if (bytes.length > maxBytes) {
        throw tooLarge(verb, target, `content exceeds the ${maxBytes}-byte limit`)
      }
      return { data: bytes.toString('base64') }
    },

    async readByteRange(path, offset, length) {
      const verb = 'read'
      const target = absolutePath(verb, path, root)
      const info = await probe(verb, target, true)
      if (info === null) throw notFound(verb, target)
      if (!info.isFile()) throw notRegularFile(verb, target)
      if (length === 0) return { data: '' }
      const wanted = Math.min(length, Math.max(Number(info.size) - offset, 0))
      if (wanted === 0) return { data: '' }
      return { data: (await readWindow(verb, target, offset, wanted)).toString('base64') }
    },

    async writeText(path, content, expected) {
      const verb = 'write'
      const target = absolutePath(verb, path, root)
      const existing = await probe(verb, target, true)
      if (existing !== null && !existing.isFile()) throw notRegularFile(verb, target)
      guardWrite(verb, target, existing, expected)
      const before = existing === null ? null : await readBasis(verb, target, Number(existing.size))
      await publish(verb, target, content, expected?.kind === 'createIfAbsent', modeOf(existing))
      const after = await probe(verb, target, true)
      return {
        operation: existing === null ? 'create' : 'update',
        version: after === null ? missingVersion(target) : versionOf(after),
        before,
        after: normalizeLineEndings(content),
      }
    },

    async editText(path, edit, expected) {
      const verb = 'edit'
      const target = absolutePath(verb, path, root)
      const existing = await probe(verb, target, true)
      if (existing === null) throw staleVersion(verb, target, 'file changed since it was read')
      if (!existing.isFile()) throw notRegularFile(verb, target)
      if (expected !== undefined && versionOf(existing) !== expected) {
        throw staleVersion(verb, target, 'file changed since it was read')
      }
      const current = await readForEdit(verb, target)
      const edited = applyLiteralEdit(current.text, edit, target)
      await publish(verb, target, restoreLineEndings(edited, current.lineEndings), false, modeOf(existing))
      const after = await probe(verb, target, true)
      return {
        version: after === null ? missingVersion(target) : versionOf(after),
        before: current.text,
        after: normalizeLineEndings(edited),
      }
    },
  }
}

/** Bigint metadata for `path`, or `null` when the path (or a parent segment) is absent. */
async function probe(verb: string, path: string, follow: boolean): Promise<BigIntStats | null> {
  try {
    return follow ? await stat(path, { bigint: true }) : await lstat(path, { bigint: true })
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return null
    throw ioFailure(verb, path, error)
  }
}

/** Whether a rejection carries one of the given `errno` codes. */
function isErrno(error: unknown, ...codes: readonly string[]): boolean {
  return error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && codes.includes(error.code)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Map a filesystem rejection onto the code the plugin rethrows. */
function ioFailure(verb: string, path: string, error: unknown): FsFailure {
  if (isErrno(error, 'ENOENT', 'ENOTDIR')) return notFound(verb, path)
  if (isErrno(error, 'EACCES', 'EPERM')) {
    return new FsFailure('FS_PERMISSION_DENIED', `cannot ${verb} "${path}": permission denied`, { cause: error })
  }
  return new FsFailure('FS_IO_ERROR', `cannot ${verb} "${path}": ${describe(error)}`, { cause: error })
}

function notFound(verb: string, path: string): FsFailure {
  return new FsFailure('FS_NOT_FOUND', `cannot ${verb} "${path}": not found`)
}

function notRegularFile(verb: string, path: string): FsFailure {
  return new FsFailure('FS_NOT_REGULAR_FILE', `cannot ${verb} "${path}": not a regular file`)
}

function staleVersion(verb: string, path: string, detail: string): FsFailure {
  return new FsFailure('FS_STALE_VERSION', `cannot ${verb} "${path}": ${detail}`)
}

function tooLarge(verb: string, path: string, detail: string): FsFailure {
  return new FsFailure('FS_TOO_LARGE', `cannot ${verb} "${path}": ${detail}`)
}

function fileType(info: BigIntStats): WireFileType {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  return 'other'
}

function pathType(info: BigIntStats): WirePathType {
  return info.isSymbolicLink() ? 'symlink' : fileType(info)
}

/**
 * The POSIX permission bits to preserve for a replaced file.
 * @param info - the metadata observed before the write, or `null` for a create.
 * @returns the mode, or `undefined` to let the new file take the process default.
 */
function modeOf(info: BigIntStats | null): number | undefined {
  return info === null ? undefined : Number(info.mode & 0o777n)
}

/**
 * Reject a guarded write whose precondition no longer holds.
 * @param verb - the operation named in the failure.
 * @param target - the canonical destination.
 * @param existing - the metadata observed immediately before the write.
 * @param expected - the caller's guard, or `undefined` for an unconditional write.
 * @throws FsFailure `FS_STALE_VERSION` or `FS_NOT_OBSERVED`.
 */
function guardWrite(
  verb: string,
  target: string,
  existing: BigIntStats | null,
  expected: WireWriteIntent | undefined,
): void {
  if (expected?.kind === 'replaceIfVersion') {
    if (existing === null) throw staleVersion(verb, target, 'file no longer exists')
    if (versionOf(existing) !== expected.version) {
      throw staleVersion(verb, target, 'file changed since it was read')
    }
    return
  }
  if (expected?.kind === 'createIfAbsent' && existing !== null) {
    throw new FsFailure(
      'FS_NOT_OBSERVED',
      `cannot overwrite existing "${target}" without reading it first`,
    )
  }
}

/**
 * Publish text, translating a lost no-replace race into the protocol's code.
 * @param verb - the operation named in the failure.
 * @param target - the canonical destination.
 * @param content - the complete text to publish.
 * @param createIfAbsent - publish without replacing an existing destination.
 * @param mode - permission bits to preserve, or `undefined` for a new file.
 * @throws FsFailure `FS_NOT_OBSERVED` when the destination appeared first.
 */
async function publish(
  verb: string,
  target: string,
  content: string,
  createIfAbsent: boolean,
  mode: number | undefined,
): Promise<void> {
  try {
    await publishText(target, content, { createIfAbsent, mode })
  } catch (error: unknown) {
    if (isErrno(error, 'EEXIST')) {
      throw new FsFailure(
        'FS_NOT_OBSERVED',
        `cannot overwrite existing "${target}" without reading it first`,
        { cause: error },
      )
    }
    throw ioFailure(verb, target, error)
  }
}

/**
 * Best-effort LF-normalized pre-image for a write's diff basis.
 * @param verb - the operation named if the descriptor cannot be opened at all.
 * @param path - the file to read.
 * @param size - its size as observed before the write.
 * @returns the LF-normalized text, or `null` for an oversized, binary,
 *   non-UTF-8, or unreadable pre-image; a presentation-only basis never fails
 *   the write that follows.
 */
async function readBasis(verb: string, path: string, size: number): Promise<string | null> {
  try {
    if (size >= DIFF_BASIS_MAX_BYTES) return null
    const bytes = await readWindow(verb, path, 0, size)
    if (bytes.includes(0)) return null
    return normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    // An unreadable or raced pre-image costs only the contextual diff; the
    // caller falls back to a whole-file diff of the committed write.
    return null
  }
}

/** Line-ending style detected before LF normalization. */
type LineEndings = 'LF' | 'CRLF'

/** The text to edit, LF-normalized, plus the style to restore on write-back. */
interface EditSource {
  readonly text: string
  readonly lineEndings: LineEndings
}

/**
 * Read a whole file for editing, rejecting binary content.
 * @param verb - the operation named in failures.
 * @param path - the regular file to read.
 * @returns the LF-normalized text and the line-ending style to restore.
 * @throws FsFailure `FS_NOT_TEXT` for NUL bytes or invalid UTF-8.
 */
async function readForEdit(verb: string, path: string): Promise<EditSource> {
  const bytes = await readAllBytes(verb, path)
  if (bytes.includes(0)) {
    throw new FsFailure('FS_NOT_TEXT', `cannot ${verb} "${path}": binary file`)
  }
  const raw = decodeText(verb, path, bytes)
  return { text: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw) }
}

/**
 * Apply one literal replacement to LF-normalized content.
 * @param content - the current content, already LF-normalized.
 * @param edit - the literal match and replacement, normalized the same way.
 * @param path - the path named in failures.
 * @returns the edited content, not yet restored to the file's line-ending style.
 * @throws FsFailure `FS_EDIT_NOT_FOUND` for an empty or absent match,
 *   `FS_AMBIGUOUS_EDIT` for multiple matches without `replaceAll`.
 */
function applyLiteralEdit(content: string, edit: WireEditRequest, path: string): string {
  const oldText = normalizeLineEndings(edit.oldString)
  if (oldText.length === 0) {
    throw new FsFailure('FS_EDIT_NOT_FOUND', 'old_string must be a non-empty string')
  }
  const newText = normalizeLineEndings(edit.newString)
  const matches = countOccurrences(content, oldText)
  if (matches === 0) {
    throw new FsFailure('FS_EDIT_NOT_FOUND', `old_string was not found in "${path}"`)
  }
  if (!edit.replaceAll && matches > 1) {
    throw new FsFailure(
      'FS_AMBIGUOUS_EDIT',
      `old_string matched ${matches} times in "${path}"; provide a more specific old_string or set replace_all to true`,
    )
  }
  return content.split(oldText).join(newText)
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/** Collapse `\r\n` to `\n`; a lone `\r` is left alone. */
function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

/** The dominant line-ending style in the first 4 KiB. */
function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf ? 'CRLF' : 'LF'
}

/** Convert LF-normalized content back to `lineEndings` for write-back. */
function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

/**
 * Length of the trailing fragment that belongs to a code point continued after
 * the window.
 *
 * A window is decoded only up to this boundary, so the returned text never
 * ends inside a UTF-8 sequence; the caller's next window starts there and
 * completes it. Zero also covers trailing bytes that are simply invalid, which
 * the decoder must report itself.
 * @param bytes - the raw window.
 * @returns 0-3 bytes of an incomplete trailing sequence.
 */
function trailingFragmentLength(bytes: Uint8Array): number {
  for (let back = 1; back <= 3 && back <= bytes.length; back += 1) {
    const byte = bytes[bytes.length - back]!
    if ((byte & 0xc0) === 0x80) continue
    if ((byte & 0x80) === 0x00) return back - 1
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2
    return width > back ? back : 0
  }
  return 0
}

/**
 * Decode a boundary-aligned window as UTF-8 text.
 * @param verb - the operation named in the failure.
 * @param path - the path named in the failure.
 * @param bytes - complete UTF-8 sequences.
 * @returns the decoded text.
 * @throws FsFailure `FS_NOT_TEXT` for NUL bytes or invalid sequences.
 */
function decodeText(verb: string, path: string, bytes: Uint8Array): string {
  if (bytes.includes(0)) {
    throw new FsFailure('FS_NOT_TEXT', `cannot ${verb} "${path}": binary file`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error
    throw new FsFailure('FS_NOT_TEXT', `cannot ${verb} "${path}": invalid UTF-8 text`)
  }
}

/** Read exactly `length` bytes at `offset`, or fewer at end of file. */
async function readWindow(verb: string, path: string, offset: number, length: number): Promise<Buffer> {
  if (length > bufferConstants.MAX_LENGTH) {
    throw tooLarge(verb, path, `${length} bytes exceeds the ${bufferConstants.MAX_LENGTH}-byte read limit`)
  }
  if (length === 0) return Buffer.alloc(0)
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch (error: unknown) {
    throw ioFailure(verb, path, error)
  }
  try {
    const buffer = Buffer.allocUnsafe(length)
    let total = 0
    while (total < length) {
      const { bytesRead } = await handle.read(buffer, total, length - total, offset + total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    return buffer.subarray(0, total)
  } catch (error: unknown) {
    throw ioFailure(verb, path, error)
  } finally {
    try {
      await handle.close()
    } catch {
      // A close errno cannot change content already read; the primary failure,
      // if any, is the one the caller must see.
    }
  }
}

/** Read a whole file through to end of file. */
async function readAllBytes(verb: string, path: string): Promise<Buffer> {
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch (error: unknown) {
    throw ioFailure(verb, path, error)
  }
  try {
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.allocUnsafe(READ_ALL_CHUNK_BYTES)
      const { bytesRead } = await handle.read(chunk, 0, READ_ALL_CHUNK_BYTES, total)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > bufferConstants.MAX_LENGTH) {
        throw tooLarge(verb, path, `content exceeds the ${bufferConstants.MAX_LENGTH}-byte read limit`)
      }
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, total)
  } catch (error: unknown) {
    if (error instanceof FsFailure) throw error
    throw ioFailure(verb, path, error)
  } finally {
    try {
      await handle.close()
    } catch {
      // A close errno cannot change content already read; the primary failure,
      // if any, is the one the caller must see.
    }
  }
}
