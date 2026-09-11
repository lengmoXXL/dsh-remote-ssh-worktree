/**
 * Git worktree operations behind the daemon's `git.*` wire methods.
 *
 * Every command is an argv array handed to `execFile`, so a branch name or a
 * path can never be reinterpreted by a shell, and every command carries a
 * bounded timeout that kills the child. Failures are classified from git's own
 * output after the command ran rather than from a pre-flight guess, so a state
 * change between a check and the command cannot produce the wrong code.
 *
 * @module dsh-remote-agent/git
 */

import { execFile } from 'node:child_process'
import type {
  WireGitErrorCode,
  WireMergeOutcome,
  WireRepoState,
  WireWorktree,
} from '../../shared/protocol.ts'
import { absolutePath } from './fs.ts'

/** Bound on one git invocation; the child is killed when it elapses. */
const GIT_TIMEOUT_MS = 120_000

/** Bound on captured git output; porcelain listings are far smaller. */
const GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024

/** Longest slice of git's own output repeated in a failure message. */
const GIT_DETAIL_MAX_CHARS = 2_000

/**
 * Identity and commit settings for a merge git has to create. They are passed
 * on the command line so a machine with no configured git identity still
 * merges, and signing is disabled so no key prompt can block the daemon.
 */
const MERGE_IDENTITY: readonly string[] = [
  '-c', 'user.name=dsh-remote-agent',
  '-c', 'user.email=dsh-remote-agent@localhost',
  '-c', 'commit.gpgsign=false',
]

/** One finished `git` invocation. */
interface GitOutcome {
  /** Whether git exited 0. */
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  /** Exit status, or `null` when git could not be spawned. */
  readonly status: number | null
  /** Whether the invocation's timeout killed the child. */
  readonly timedOut: boolean
  /** Spawn-level failure text; empty after a normal exit. */
  readonly spawnError: string
}

/** A git operation failure carrying the protocol's own stable code. */
export class GitFailure extends Error {
  /** The wire code the plugin rethrows unchanged. */
  readonly code: WireGitErrorCode

  /**
   * @param code - the wire code the plugin rethrows unchanged.
   * @param message - human-readable detail the plugin logs but does not parse.
   * @param options - optional underlying cause.
   */
  constructor(code: WireGitErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GitFailure'
    this.code = code
  }
}

/** The git worktree methods the daemon serves, one per `git.*` wire method. */
export interface GitBackend {
  /**
   * Create a worktree checkout on a new branch.
   * @param repoPath - an existing checkout of the repository.
   * @param worktreePath - absolute path of the checkout to create.
   * @param branch - short name of the branch to create.
   * @param baseRef - revision to start from, or `undefined` for the repository's HEAD.
   * @returns the created worktree.
   * @throws GitFailure `GIT_NOT_A_REPOSITORY`, `GIT_BRANCH_EXISTS`,
   *   `GIT_WORKTREE_EXISTS`, `GIT_REF_NOT_FOUND`, or `GIT_COMMAND_FAILED`.
   */
  worktreeAdd(
    repoPath: string,
    worktreePath: string,
    branch: string,
    baseRef: string | undefined,
  ): Promise<WireWorktree>
  /**
   * List the repository's worktrees in git's own order.
   * @param repoPath - an existing checkout of the repository.
   * @returns the worktrees, the primary checkout first and marked `main`.
   * @throws GitFailure `GIT_NOT_A_REPOSITORY` or `GIT_COMMAND_FAILED`.
   */
  worktreeList(repoPath: string): Promise<readonly WireWorktree[]>
  /**
   * Remove a worktree checkout and prune its administrative entry.
   * @param repoPath - an existing checkout of the repository.
   * @param worktreePath - the checkout to remove.
   * @param force - remove even with modified or untracked files.
   * @returns an empty result object.
   * @throws GitFailure `GIT_DIRTY` when the checkout has local changes and
   *   `force` is false, plus the codes `worktreeList` raises.
   */
  worktreeRemove(repoPath: string, worktreePath: string, force: boolean): Promise<Record<string, never>>
  /**
   * Delete a branch.
   * @param repoPath - an existing checkout of the repository.
   * @param branch - short branch name.
   * @param force - delete even when the branch is not merged.
   * @returns an empty result object.
   * @throws GitFailure `GIT_DIRTY` when the branch is unmerged and `force` is
   *   false, `GIT_REF_NOT_FOUND` when it does not exist, or `GIT_COMMAND_FAILED`.
   */
  branchDelete(repoPath: string, branch: string, force: boolean): Promise<Record<string, never>>
  /**
   * Report the repository's current branch and whether its tree is clean.
   * @param repoPath - an existing checkout of the repository.
   * @returns the branch, or `null` when HEAD is detached, and whether
   *   `git status --porcelain` is empty.
   * @throws GitFailure `GIT_NOT_A_REPOSITORY` or `GIT_COMMAND_FAILED`.
   */
  repoState(repoPath: string): Promise<WireRepoState>
  /**
   * Merge a branch into the repository's current branch.
   *
   * A branch already contained in HEAD reports `alreadyMerged` and changes
   * nothing. A merge that stops on conflicts is aborted before the failure is
   * raised, so the repository is never left mid-merge.
   * @param repoPath - an existing checkout of the repository.
   * @param branch - the branch to merge in.
   * @returns the resulting HEAD and whether the merge was a no-op.
   * @throws GitFailure `GIT_DIRTY` for a conflicted or blocked merge,
   *   `GIT_REF_NOT_FOUND` for an unknown branch, or `GIT_COMMAND_FAILED`.
   */
  mergeBranch(repoPath: string, branch: string): Promise<WireMergeOutcome>
}

/**
 * Build the git backend for one daemon process.
 * @param root - absolute default base for relative paths, or `undefined` to
 *   reject them; the daemon never falls back to its own working directory.
 * @returns the backend bound to that base.
 */
export function createGitBackend(root: string | undefined): GitBackend {
  return {
    async worktreeAdd(repoPath, worktreePath, branch, baseRef) {
      const repo = absolutePath('add a worktree to', repoPath, root)
      const target = absolutePath('add a worktree to', worktreePath, root)
      await requireRepository('add a worktree to', repo)
      const args = ['worktree', 'add', '-b', branch, target]
      if (baseRef !== undefined) args.push(baseRef)
      const outcome = await run(repo, args)
      if (!outcome.ok) throw classifyAdd(repo, target, branch, outcome)
      return await describeWorktree(target)
    },

    async worktreeList(repoPath) {
      const repo = absolutePath('list the worktrees of', repoPath, root)
      await requireRepository('list the worktrees of', repo)
      const outcome = await run(repo, ['worktree', 'list', '--porcelain'])
      if (!outcome.ok) throw commandFailed(`cannot list the worktrees of "${repo}"`, outcome)
      return parseWorktreeList(outcome.stdout)
    },

    async worktreeRemove(repoPath, worktreePath, force) {
      const repo = absolutePath('remove a worktree from', repoPath, root)
      const target = absolutePath('remove a worktree from', worktreePath, root)
      await requireRepository('remove a worktree from', repo)
      const args = ['worktree', 'remove']
      if (force) args.push('--force')
      args.push(target)
      const outcome = await run(repo, args)
      if (!outcome.ok) {
        if (says(outcome, /contains modified or untracked files/i)) {
          throw new GitFailure(
            'GIT_DIRTY',
            `cannot remove "${target}": it contains modified or untracked files; retry with force`,
          )
        }
        throw commandFailed(`cannot remove the worktree "${target}"`, outcome)
      }
      const prune = await run(repo, ['worktree', 'prune'])
      if (!prune.ok) throw commandFailed(`cannot prune the worktrees of "${repo}"`, prune)
      return {}
    },

    async branchDelete(repoPath, branch, force) {
      const repo = absolutePath('delete a branch of', repoPath, root)
      await requireRepository('delete a branch of', repo)
      const outcome = await run(repo, ['branch', force ? '-D' : '-d', branch])
      if (!outcome.ok) {
        if (says(outcome, /not fully merged/i)) {
          throw new GitFailure(
            'GIT_DIRTY',
            `cannot delete branch "${branch}": it is not fully merged; retry with force`,
          )
        }
        if (says(outcome, /branch .* not found/i) || isMissingRef(outcome)) {
          throw new GitFailure('GIT_REF_NOT_FOUND', `cannot delete branch "${branch}": ${detail(outcome)}`)
        }
        throw commandFailed(`cannot delete branch "${branch}"`, outcome)
      }
      return {}
    },

    async repoState(repoPath) {
      const repo = absolutePath('read the state of', repoPath, root)
      await requireRepository('read the state of', repo)
      const status = await run(repo, ['status', '--porcelain'])
      if (!status.ok) throw commandFailed(`cannot read the state of "${repo}"`, status)
      // `--abbrev-ref HEAD` answers `HEAD` for a detached checkout and fails on
      // an unborn one; neither names a branch, so both report null.
      const head = await run(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
      return {
        branch: head.ok ? shortBranch(head.stdout.trim()) : null,
        clean: status.stdout.trim().length === 0,
      }
    },

    async mergeBranch(repoPath, branch) {
      const repo = absolutePath('merge into', repoPath, root)
      await requireRepository('merge into', repo)

      const ancestor = await run(repo, ['merge-base', '--is-ancestor', branch, 'HEAD'])
      if (ancestor.ok) return { head: await headOf(repo), alreadyMerged: true }
      if (ancestor.status !== 1) {
        if (isMissingRef(ancestor)) {
          throw new GitFailure('GIT_REF_NOT_FOUND', `cannot merge "${branch}" into "${repo}": ${detail(ancestor)}`)
        }
        throw commandFailed(`cannot merge "${branch}" into "${repo}"`, ancestor)
      }

      const outcome = await run(repo, [...MERGE_IDENTITY, 'merge', '--no-edit', branch])
      if (outcome.ok) return { head: await headOf(repo), alreadyMerged: false }

      // Collect the conflicted paths and unwind before answering: a caller
      // that receives a failure must not inherit a repository stuck mid-merge.
      const conflicts = await conflictedPaths(repo)
      await run(repo, ['merge', '--abort'])
      if (conflicts.length > 0) {
        throw new GitFailure(
          'GIT_DIRTY',
          `merge of "${branch}" into "${repo}" stopped on conflicts: ${conflicts.join(', ')}`,
        )
      }
      if (says(outcome, /would be overwritten|local changes/i)) {
        throw new GitFailure('GIT_DIRTY', `merge of "${branch}" into "${repo}" stopped: ${detail(outcome)}`)
      }
      if (isMissingRef(outcome)) {
        throw new GitFailure('GIT_REF_NOT_FOUND', `cannot merge "${branch}" into "${repo}": ${detail(outcome)}`)
      }
      throw commandFailed(`cannot merge "${branch}" into "${repo}"`, outcome)
    },
  }
}

/**
 * Run one git command.
 * @param repoPath - the directory `git -C` starts in.
 * @param args - arguments passed as an argv array; no shell is involved.
 * @returns the finished invocation, including a non-zero exit.
 */
async function run(repoPath: string, args: readonly string[]): Promise<GitOutcome> {
  return await new Promise<GitOutcome>(resolve => {
    execFile(
      'git',
      ['-C', repoPath, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        encoding: 'utf8',
        windowsHide: true,
        // A daemon has no terminal: a prompt for credentials or an editor
        // would hold the invocation until the timeout kills it.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout, stderr, status: 0, timedOut: false, spawnError: '' })
          return
        }
        const failure = error as { code?: unknown; killed?: unknown; message?: unknown }
        resolve({
          ok: false,
          stdout,
          stderr,
          status: typeof failure.code === 'number' ? failure.code : null,
          timedOut: failure.killed === true,
          spawnError: typeof failure.code === 'string' && typeof failure.message === 'string' ? failure.message : '',
        })
      },
    )
  })
}

/** Fail unless `repoPath` is inside a git repository. */
async function requireRepository(verb: string, repoPath: string): Promise<void> {
  const outcome = await run(repoPath, ['rev-parse', '--git-dir'])
  if (!outcome.ok) {
    throw new GitFailure(
      'GIT_NOT_A_REPOSITORY',
      `cannot ${verb} "${repoPath}": not a git repository: ${detail(outcome)}`,
    )
  }
}

/** Classify a failed `git worktree add` from git's own output. */
function classifyAdd(repo: string, target: string, branch: string, outcome: GitOutcome): GitFailure {
  // The branch message also says "already exists", so it is matched first.
  if (says(outcome, /a branch named .* already exists/i)) {
    return new GitFailure(
      'GIT_BRANCH_EXISTS',
      `cannot add a worktree to "${repo}": branch "${branch}" already exists`,
    )
  }
  if (says(outcome, /already exists|already registered|is a main working tree/i)) {
    return new GitFailure(
      'GIT_WORKTREE_EXISTS',
      `cannot add a worktree to "${repo}": "${target}" already exists`,
    )
  }
  if (isMissingRef(outcome)) {
    return new GitFailure('GIT_REF_NOT_FOUND', `cannot add a worktree to "${repo}": ${detail(outcome)}`)
  }
  return commandFailed(`cannot add a worktree to "${repo}"`, outcome)
}

/** Read back the worktree a successful `worktree add` created. */
async function describeWorktree(path: string): Promise<WireWorktree> {
  const head = await run(path, ['rev-parse', 'HEAD'])
  if (!head.ok) throw commandFailed(`cannot read the worktree "${path}"`, head)
  const branch = await run(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch.ok) throw commandFailed(`cannot read the worktree "${path}"`, branch)
  return {
    path,
    branch: shortBranch(branch.stdout.trim()),
    head: head.stdout.trim(),
    main: false,
  }
}

/** Parse `git worktree list --porcelain`, preserving git's order. */
function parseWorktreeList(porcelain: string): readonly WireWorktree[] {
  const worktrees: WireWorktree[] = []
  let path: string | undefined
  let head = ''
  let branch: string | null = null
  const flush = (): void => {
    if (path === undefined) return
    worktrees.push({ path, branch, head, main: worktrees.length === 0 })
    path = undefined
    head = ''
    branch = null
  }
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      path = line.slice('worktree '.length).trim()
      continue
    }
    if (path === undefined) continue
    if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim()
    else if (line.startsWith('branch ')) branch = shortBranch(line.slice('branch '.length).trim())
    else if (line === 'detached' || line === 'bare') branch = null
  }
  flush()
  return worktrees
}

/** The short name a ref spelling names, or `null` for a detached or bare checkout. */
function shortBranch(ref: string): string | null {
  if (ref.length === 0 || ref === 'HEAD') return null
  const prefix = 'refs/heads/'
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref
}

/** The revision HEAD points at. */
async function headOf(repo: string): Promise<string> {
  const outcome = await run(repo, ['rev-parse', 'HEAD'])
  if (!outcome.ok) throw commandFailed(`cannot read HEAD of "${repo}"`, outcome)
  return outcome.stdout.trim()
}

/** Unmerged paths of an in-progress merge, in git's order. */
async function conflictedPaths(repo: string): Promise<readonly string[]> {
  const outcome = await run(repo, ['diff', '--name-only', '--diff-filter=U'])
  if (!outcome.ok) return []
  return outcome.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

/** Whether git's output says the named revision does not exist. */
function isMissingRef(outcome: GitOutcome): boolean {
  return says(
    outcome,
    /not a valid object name|unknown revision|ambiguous argument|did not match any|invalid reference|not something we can merge/i,
  )
}

/** Whether git's own output matches a pattern. */
function says(outcome: GitOutcome, pattern: RegExp): boolean {
  return pattern.test(outcome.stderr) || pattern.test(outcome.stdout)
}

/** Git's own words for a failure, trimmed and bounded, for a caller-facing message. */
function detail(outcome: GitOutcome): string {
  if (outcome.timedOut) return `git timed out after ${GIT_TIMEOUT_MS}ms`
  if (outcome.spawnError !== '') return outcome.spawnError
  const text = outcome.stderr.trim() || outcome.stdout.trim() || `git exited with status ${String(outcome.status)}`
  return text.length > GIT_DETAIL_MAX_CHARS ? `${text.slice(0, GIT_DETAIL_MAX_CHARS)}...` : text
}

function commandFailed(verb: string, outcome: GitOutcome): GitFailure {
  return new GitFailure('GIT_COMMAND_FAILED', `${verb}: ${detail(outcome)}`)
}
