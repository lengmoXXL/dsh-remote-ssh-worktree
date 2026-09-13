/**
 * A real git repository, for the suites whose subject is the local machine.
 *
 * The local machine runs git in this process rather than over a connection, so
 * there is no channel to stub: those cases need a repository they can cut
 * worktrees from, built by the same binary the plugin calls.
 *
 * @module dsh-workspace/tests/git
 */

import { execFile } from 'node:child_process'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Create a repository with one commit.
 * @param path - the directory to create it in.
 * @returns the repository's canonical absolute path.
 */
export async function repositoryAt(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  await run('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: path })
  await writeFile(join(path, 'README.md'), '# fixture\n')
  await run('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', 'README.md'], { cwd: path })
  await run('git', [
    '-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false',
    'commit', '-m', 'fixture',
  ], { cwd: path })
  return await realpath(path)
}
