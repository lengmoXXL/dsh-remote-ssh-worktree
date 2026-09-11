/**
 * Behavior tests for the daemon's filesystem operations, driven through the
 * same {@link FsBackend} the JSON-RPC layer calls.
 *
 * @module dsh-remote-agent/tests/fs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { FsBackend } from '../src/fs.ts'
import { FsFailure, createFsBackend } from '../src/fs.ts'

/** Run an operation expected to fail and return its protocol code. */
async function failureCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error: unknown) {
    assert.ok(error instanceof FsFailure, `expected FsFailure, got ${String(error)}`)
    return error.code
  }
  throw new Error('expected the operation to fail')
}

describe('fs backend', () => {
  let dir: string
  let fs: FsBackend

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-agent-fs-'))
    fs = createFsBackend(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('canonicalizes a symlink to its target and never guesses a relative path', async () => {
    const real = join(dir, 'real.txt')
    const link = join(dir, 'link.txt')
    const relative = join(dir, 'relative.txt')
    await writeFile(real, 'content')
    await writeFile(relative, 'content')
    await symlink(real, link)

    const viaLink = await fs.resolve(link, undefined)
    const viaReal = await fs.resolve(real, undefined)
    assert.equal(viaLink.canonicalPath, viaReal.canonicalPath)
    assert.equal(viaLink.canonicalPath, await realpath(real))

    const viaCwd = await fs.resolve('relative.txt', dir)
    assert.equal(viaCwd.canonicalPath, await realpath(relative))
    const viaRoot = await fs.resolve('relative.txt', undefined)
    assert.equal(viaRoot.canonicalPath, await realpath(relative))

    assert.equal(await failureCode(() => fs.resolve('relative.txt', 'not-absolute')), 'FS_IO_ERROR')

    const rootless = createFsBackend(undefined)
    assert.equal(await failureCode(() => rootless.stat('relative.txt')), 'FS_IO_ERROR')
    assert.equal(await failureCode(() => rootless.resolve('relative.txt', undefined)), 'FS_IO_ERROR')
    assert.equal((await rootless.resolve(relative, undefined)).canonicalPath, await realpath(relative))
  })

  it('resolves a target that does not exist yet through its deepest existing ancestor', async () => {
    const canonicalDir = await realpath(dir)
    await mkdir(join(dir, 'sub'))

    // The create flow resolves its destination before the file exists.
    const flat = await fs.resolve(join(dir, 'created.txt'), undefined)
    assert.equal(flat.canonicalPath, join(canonicalDir, 'created.txt'))

    // The tail may span directories that do not exist yet, and the path is
    // normalized before the tail is appended.
    const nested = await fs.resolve(join(dir, 'missing', 'deeper', 'created.txt'), undefined)
    assert.equal(nested.canonicalPath, join(canonicalDir, 'missing', 'deeper', 'created.txt'))
    const dotDot = await fs.resolve(join(dir, 'sub', '..', 'created.txt'), undefined)
    assert.equal(dotDot.canonicalPath, join(canonicalDir, 'created.txt'))

    // Resolving is not observing: the same path still reports absent.
    assert.equal(await fs.stat(flat.canonicalPath), null)
    assert.equal(await fs.lstat(flat.canonicalPath, undefined), null)

    // A regular file where a directory is required can never be a target.
    await writeFile(join(dir, 'file.txt'), 'x')
    assert.equal(await failureCode(() => fs.resolve(join(dir, 'file.txt', 'child'), undefined)), 'FS_NOT_FOUND')
  })

  it('reports an absent target as null rather than throwing', async () => {
    assert.equal(await fs.stat(join(dir, 'missing')), null)
    assert.equal(await fs.lstat(join(dir, 'missing'), undefined), null)

    const file = join(dir, 'file.txt')
    await writeFile(file, 'abc')
    const info = await fs.stat(file)
    assert.ok(info !== null)
    assert.equal(info.type, 'file')
    assert.equal(info.size, 3)
    assert.equal(typeof info.version, 'string')

    const link = join(dir, 'link.txt')
    await symlink(file, link)
    assert.equal((await fs.lstat(link, undefined))?.type, 'symlink')
    assert.equal((await fs.stat(link))?.type, 'file')
  })

  it('lists direct children in name order with resolved targets', async () => {
    await writeFile(join(dir, 'b.txt'), 'bb')
    await writeFile(join(dir, 'a.txt'), 'a')
    const nested = join(dir, 'c-dir')
    await mkdir(nested)
    await writeFile(join(nested, 'child.txt'), 'x')

    const entries = await fs.listDir(dir)
    assert.deepEqual(entries.map(entry => entry.name), ['a.txt', 'b.txt', 'c-dir'])
    assert.equal(entries[0]?.target.canonicalPath, await realpath(join(dir, 'a.txt')))
    assert.equal(entries[0]?.size, 1)
    assert.equal(entries[2]?.type, 'directory')
    assert.equal(entries[2]?.size, undefined)
  })

  it('pages a multi-megabyte file and reassembles it byte-identically', async () => {
    const bytes = Buffer.from('aé€🙂\nxyz'.repeat(200_000), 'utf8')
    assert.ok(bytes.length > 2 * 1024 * 1024, `fixture is only ${bytes.length} bytes`)
    const target = join(dir, 'big.txt')
    await writeFile(target, bytes)

    let offset = 0
    let text = ''
    let windows = 0
    for (;;) {
      const chunk = await fs.readTextChunk(target, offset, 4096)
      assert.ok(!chunk.text.includes('\uFFFD'), 'a window split a code point')
      assert.ok(chunk.nextOffset > offset, 'a window made no progress')
      text += chunk.text
      offset = chunk.nextOffset
      windows += 1
      assert.ok(windows < 5000, 'the page loop did not terminate')
      if (chunk.eof) break
    }

    assert.ok(windows > 100, `only ${windows} windows for ${bytes.length} bytes`)
    assert.equal(offset, bytes.length)
    assert.deepEqual(Buffer.from(text, 'utf8'), bytes)
  })

  it('rejects binary bytes and invalid UTF-8 as FS_NOT_TEXT', async () => {
    const nul = join(dir, 'nul.bin')
    await writeFile(nul, Buffer.from([0x41, 0x00, 0x42]))
    assert.equal(await failureCode(() => fs.readTextChunk(nul, 0, 4096)), 'FS_NOT_TEXT')

    const invalid = join(dir, 'invalid.bin')
    await writeFile(invalid, Buffer.from([0xff, 0xfe]))
    assert.equal(await failureCode(() => fs.readTextChunk(invalid, 0, 4096)), 'FS_NOT_TEXT')

    const truncated = join(dir, 'truncated.bin')
    await writeFile(truncated, Buffer.from([0x61, 0xe2, 0x82]))
    assert.equal(await failureCode(() => fs.readTextChunk(truncated, 0, 4096)), 'FS_NOT_TEXT')
  })

  it('reads raw byte windows and refuses a whole file beyond maxBytes', async () => {
    const target = join(dir, 'bytes.bin')
    await writeFile(target, Buffer.from([1, 2, 3, 4, 5]))

    const whole = await fs.readBytes(target, 5)
    assert.deepEqual(Buffer.from(whole.data, 'base64'), Buffer.from([1, 2, 3, 4, 5]))
    assert.equal(await failureCode(() => fs.readBytes(target, 4)), 'FS_TOO_LARGE')

    const window = await fs.readByteRange(target, 1, 3)
    assert.deepEqual(Buffer.from(window.data, 'base64'), Buffer.from([2, 3, 4]))
    const past = await fs.readByteRange(target, 9, 3)
    assert.deepEqual(Buffer.from(past.data, 'base64'), Buffer.alloc(0))
  })

  it('fails createIfAbsent on an existing target and reports a create otherwise', async () => {
    const target = join(dir, 'created.txt')
    const created = await fs.writeText(target, 'hello', { kind: 'createIfAbsent' })
    assert.equal(created.operation, 'create')
    assert.equal(created.before, null)
    assert.equal(created.after, 'hello')
    assert.equal(await readFile(target, 'utf8'), 'hello')

    assert.equal(
      await failureCode(() => fs.writeText(target, 'again', { kind: 'createIfAbsent' })),
      'FS_NOT_OBSERVED',
    )
    assert.equal(await readFile(target, 'utf8'), 'hello')
  })

  it('checks replaceIfVersion against the observed version', async () => {
    const target = join(dir, 'guarded.txt')
    await writeFile(target, 'first')
    const observed = await fs.stat(target)
    assert.ok(observed !== null)

    const updated = await fs.writeText(target, 'second version', {
      kind: 'replaceIfVersion',
      version: observed.version,
    })
    assert.equal(updated.operation, 'update')
    assert.equal(updated.before, 'first')
    assert.equal(updated.after, 'second version')
    assert.equal(await readFile(target, 'utf8'), 'second version')

    assert.equal(
      await failureCode(() => fs.writeText(target, 'third', {
        kind: 'replaceIfVersion',
        version: observed.version,
      })),
      'FS_STALE_VERSION',
    )
    assert.equal(
      await failureCode(() => fs.writeText(join(dir, 'absent.txt'), 'third', {
        kind: 'replaceIfVersion',
        version: observed.version,
      })),
      'FS_STALE_VERSION',
    )
    assert.equal(await readFile(target, 'utf8'), 'second version')
  })

  it('applies literal edits and reports not-found, ambiguous, and replaceAll', async () => {
    const target = join(dir, 'edit.txt')
    await writeFile(target, 'alpha beta alpha')

    assert.equal(
      await failureCode(() => fs.editText(target, { oldString: 'gamma', newString: 'x', replaceAll: false }, undefined)),
      'FS_EDIT_NOT_FOUND',
    )
    assert.equal(
      await failureCode(() => fs.editText(target, { oldString: 'alpha', newString: 'x', replaceAll: false }, undefined)),
      'FS_AMBIGUOUS_EDIT',
    )
    // The version guard runs before matching: an unrelated oldString still
    // reports the stale read rather than a match failure.
    assert.equal(
      await failureCode(() => fs.editText(target, { oldString: 'gamma', newString: 'x', replaceAll: false }, 'stale')),
      'FS_STALE_VERSION',
    )

    const all = await fs.editText(target, { oldString: 'alpha', newString: 'omega', replaceAll: true }, undefined)
    assert.equal(all.before, 'alpha beta alpha')
    assert.equal(all.after, 'omega beta omega')
    assert.equal(await readFile(target, 'utf8'), 'omega beta omega')
  })

  it('matches edits across line-ending styles and preserves the file style', async () => {
    const target = join(dir, 'crlf.txt')
    await writeFile(target, 'one\r\ntwo\r\nthree\r\n')

    const outcome = await fs.editText(
      target,
      { oldString: 'one\ntwo', newString: 'two\nthree', replaceAll: false },
      undefined,
    )
    assert.equal(outcome.before, 'one\ntwo\nthree\n')
    assert.equal(outcome.after, 'two\nthree\nthree\n')
    assert.equal(await readFile(target, 'utf8'), 'two\r\nthree\r\nthree\r\n')
  })

  it('publishes atomically and leaves no staging file behind', async () => {
    const target = join(dir, 'atomic.txt')
    await fs.writeText(target, 'content', undefined)
    assert.deepEqual(await readdir(dir), ['atomic.txt'])

    const observed = await fs.stat(target)
    assert.ok(observed !== null)
    await fs.writeText(target, 'content 2', { kind: 'replaceIfVersion', version: observed.version })
    assert.deepEqual(await readdir(dir), ['atomic.txt'])

    await failureCode(() => fs.writeText(target, 'content 3', { kind: 'createIfAbsent' }))
    assert.deepEqual(await readdir(dir), ['atomic.txt'])
    assert.equal(await readFile(target, 'utf8'), 'content 2')
  })
})
