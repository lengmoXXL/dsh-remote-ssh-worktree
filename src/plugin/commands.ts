/**
 * The `/rwt` human command.
 *
 * A human has to be able to set a machine up and take a worktree down without
 * asking the model to do it, so this surface exists beside the model tools
 * rather than behind them. Every subcommand prints the exact command that
 * finishes the job, because the two halves — a checkout on the node and an
 * anchor here — are cleaned up by different operations.
 *
 * @module dsh-remote-ssh-worktree/plugin/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { NodeConnections } from '../nodes/connections.ts'
import type { NodeRegistry } from '../storage/nodes.ts'
import { defaultNodeTitle } from '../storage/nodes.ts'
import { asAnchorId, asNodeId } from '../ids.ts'
import type { WorktreeManager } from '../worktree/manager.ts'

/** What the command needs from the plugin. */
export interface WorktreeCommandDeps {
  /** The remote worktree lifecycle. */
  readonly worktrees: WorktreeManager
  /** Durable node records. */
  readonly registry: NodeRegistry
  /** Live connections. */
  readonly connections: NodeConnections
}

/** The usage line shown when the arguments do not parse. */
const USAGE = 'usage: /rwt list | nodes | create <nodeId> <repoPath> <name> [baseRef] '
  + '| remove <anchorId> [--force] [--delete-branch]'

/** Split a raw invocation into whitespace-separated arguments. */
function args(rawInput: string): string[] {
  return rawInput.trim().split(/\s+/).filter(part => part !== '')
}

/** Render the failure text for an unknown anchor or node. */
function failure(error: unknown): CommandResult {
  return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
}

/**
 * Execute one `/rwt` invocation.
 *
 * Exported so the grammar is testable without a live command registry.
 * @param rawInput - the text following `/rwt`.
 * @param deps - the lifecycle, the node registry, and the connection manager.
 * @returns the command result to render.
 */
export async function runWorktreeCommand(
  rawInput: string,
  deps: WorktreeCommandDeps,
): Promise<CommandResult> {
  const [subcommand, ...rest] = args(rawInput)

  if (subcommand === 'list' || subcommand === undefined) {
    const statuses = await deps.worktrees.list()
    if (statuses.length === 0) {
      return { kind: 'success', text: 'No remote worktrees. Configure a machine with `/rwt nodes`.' }
    }
    return {
      kind: 'success',
      text: statuses.map(({ anchor, open, error }) =>
        `${anchor.anchorId}  ${anchor.nodeId}:${anchor.branch}  ${open ? 'open' : 'closed'}`
        + (error === undefined ? '' : `  offline (${error})`)
        + `\n  node:   ${anchor.remoteRoot}\n  local:  ${anchor.anchorPath}`,
      ).join('\n\n'),
    }
  }

  if (subcommand === 'nodes') {
    const nodes = deps.registry.list()
    if (nodes.length === 0) {
      return { kind: 'success', text: 'No machines configured. Add one from Settings → Remote worktrees.' }
    }
    return {
      kind: 'success',
      text: nodes.map(node => {
        const status = deps.connections.status(node.nodeId)
        return `${node.nodeId}  ${node.title}  ${defaultNodeTitle(node.transport)}  ${status.state}`
      }).join('\n'),
    }
  }

  if (subcommand === 'create') {
    const [nodeId, repoPath, name, baseRef] = rest
    if (nodeId === undefined || repoPath === undefined || name === undefined) {
      return { kind: 'error', text: USAGE }
    }
    const record = deps.registry.get(asNodeId(nodeId))
    if (record === undefined) return { kind: 'error', text: `no node "${nodeId}"` }
    try {
      const anchor = await deps.worktrees.create({
        nodeId: asNodeId(nodeId),
        repoPath,
        name,
        ...baseRef === undefined ? {} : { baseRef },
      })
      return {
        kind: 'success',
        text: `Created ${anchor.branch} on ${nodeId}.\n  node:   ${anchor.remoteRoot}\n  local:  ${anchor.anchorPath}\n`
          + `Work in the local path; the file and shell tools route it to the machine.\n`
          + `Finish with \`/rwt remove ${anchor.anchorId}\` when the checkout is done with; its branch stays.`,
      }
    } catch (error) {
      return failure(error)
    }
  }

  if (subcommand === 'remove') {
    const [anchorId, ...flags] = rest
    if (anchorId === undefined) return { kind: 'error', text: USAGE }
    try {
      const removal = await deps.worktrees.remove(asAnchorId(anchorId), {
        force: flags.includes('--force'),
        // Deleting the branch is an explicit ask: this plugin owns worktrees.
        deleteBranch: flags.includes('--delete-branch'),
      })
      return {
        kind: 'success',
        text: removal.branchDeleted
          ? `Removed ${removal.anchor.branch} and its branch.`
          : `Removed ${removal.anchor.branch}; the branch is still there.`
          + (removal.branchError === undefined ? '' : `\nThe branch could not be deleted: ${removal.branchError}`),
      }
    } catch (error) {
      return failure(error)
    }
  }

  return { kind: 'error', text: `${USAGE}\nunknown subcommand "${subcommand}"` }
}

/**
 * Register `/rwt` when the deployment composes a command registry.
 * @param ctx - the plugin's context.
 * @param deps - the lifecycle, the node registry, and the connection manager.
 */
export function registerWorktreeCommand(ctx: Context, deps: WorktreeCommandDeps): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'rwt',
      description: 'Manage remote worktrees on the machines this deployment has configured',
      input: { hint: 'list | nodes | create <nodeId> <repoPath> <name> | remove <id> [--force] [--delete-branch]' },
      handler: (invocation: CommandInvocation) => runWorktreeCommand(invocation.rawInput, deps),
    })
  })
}
