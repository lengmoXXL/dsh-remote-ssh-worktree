/**
 * The model-facing remote-worktree tools.
 *
 * These are deliberately a small, separate vocabulary: the file and shell
 * tools already work inside a worktree once it exists, so the model only needs
 * to create one, look at what exists, or take it down — merging a branch is
 * ordinary git, which the shell tool already runs on the machine. Every result
 * names the machine and the local path, because the model has to be able to say
 * where its work actually lives.
 *
 * @module dsh-remote-ssh-worktree/plugin/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { asAnchorId, asNodeId } from '../ids.ts'
import type { NodeConnections } from '../nodes/connections.ts'
import type { NodeRegistry } from '../nodes/registry.ts'
import type { WorktreeManager } from '../worktree/manager.ts'

/** What the tools need from the plugin. */
export interface WorktreeToolDeps {
  /** The remote worktree lifecycle. */
  readonly worktrees: WorktreeManager
  /** Durable node records. */
  readonly registry: NodeRegistry
  /** Live connections. */
  readonly connections: NodeConnections
}

/** The text one tool result carries. */
type ToolText = { readonly text: string }

/** Render the failure text for a refused operation. */
function failure(error: unknown): string {
  return `Error: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * Register the remote-worktree tools when the deployment composes a tool registry.
 * @param ctx - the plugin's context.
 * @param deps - the lifecycle, the node registry, and the connection manager.
 */
export function registerWorktreeTools(ctx: Context, deps: WorktreeToolDeps): void {
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register(defineTool({
      name: 'rw_list',
      description: 'List the remote worktrees this session can use, with the machine each one lives on '
        + 'and whether its checkout is clean.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true } },
        },
        render: (_args, value: ToolText) => [{ type: 'text', text: value.text }],
      },
      async execute(): Promise<ToolText> {
        const statuses = await deps.worktrees.list()
        if (statuses.length === 0) {
          const nodes = deps.registry.list()
          return {
            text: nodes.length === 0
              ? 'No machines are configured in this deployment.'
              : `No remote worktrees yet. Configured machines: ${nodes.map(node => node.nodeId).join(', ')}.`,
          }
        }
        return {
          text: statuses.map(({ anchor, open, error }) => [
            `id: ${anchor.anchorId}`,
            `machine: ${anchor.nodeId}`,
            `branch: ${anchor.branch}`,
            `remote: ${anchor.remoteRoot}`,
            `local: ${anchor.anchorPath}`,
            `workspace: ${open ? 'open' : 'closed'}`,
            ...error === undefined ? [] : [`error: ${error}`],
          ].join('\n')).join('\n\n'),
        }
      },
    }))

    toolCtx.tools.register(defineTool({
      name: 'rw_create',
      description: 'Cut a new git worktree on a configured machine and open it as a local workspace. '
        + 'After this, the file and shell tools run inside that checkout when given its local path.',
      parameters: {
        nodeId: { type: 'string', required: true, description: 'Id of the machine, from rw_list or the settings page.' },
        repoPath: { type: 'string', required: true, description: 'Absolute path of the repository on that machine.' },
        name: { type: 'string', required: true, description: 'Short worktree name; the branch becomes worktree/<name>.' },
        baseRef: { type: 'string', description: 'Revision to branch from; defaults to the repository HEAD.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            anchorId: { type: 'string', required: true },
            localPath: { type: 'string', required: true },
            branch: { type: 'string', required: true },
          },
        },
        render: (_args, value: ToolText) => [{ type: 'text', text: value.text }],
      },
      async execute(args: { nodeId: string; repoPath: string; name: string; baseRef?: string }) {
        const record = deps.registry.get(asNodeId(args.nodeId))
        if (record === undefined) return { text: `Error: no machine "${args.nodeId}"`, anchorId: '', localPath: '', branch: '' }
        try {
          if (deps.connections.channel(asNodeId(args.nodeId)) === undefined) await deps.connections.connect(record)
          const anchor = await deps.worktrees.create({
            nodeId: asNodeId(args.nodeId),
            repoPath: args.repoPath,
            name: args.name,
            ...args.baseRef === undefined ? {} : { baseRef: args.baseRef },
          })
          return {
            text: `Created ${anchor.branch} on ${anchor.nodeId}.\n`
              + `Work in this local path; the file and shell tools route it to the machine:\n${anchor.anchorPath}\n`
              + `The checkout on the machine is ${anchor.remoteRoot}.\n`
              + `When the work is done, call rw_remove to drop the checkout; the branch stays for you to merge.`,
            anchorId: anchor.anchorId,
            localPath: anchor.anchorPath,
            branch: anchor.branch,
          }
        } catch (error) {
          return { text: failure(error), anchorId: '', localPath: '', branch: '' }
        }
      },
    }))

    toolCtx.tools.register(defineTool({
      name: 'rw_remove',
      description: 'Remove a remote worktree: the checkout on the machine, then its local workspace. '
        + 'Without force, uncommitted changes refuse the removal. The branch survives unless '
        + 'deleteBranch is set, so work that was not merged is not lost silently.',
      parameters: {
        anchorId: { type: 'string', required: true, description: 'Worktree id from rw_list.' },
        force: { type: 'boolean', description: 'Discard uncommitted changes instead of refusing.' },
        deleteBranch: { type: 'boolean', description: 'Delete the worktree branch as well; unmerged commits are lost.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true } },
        },
        render: (_args, value: ToolText) => [{ type: 'text', text: value.text }],
      },
      async execute(args: { anchorId: string; force?: boolean; deleteBranch?: boolean }) {
        try {
          const removal = await deps.worktrees.remove(asAnchorId(args.anchorId), {
            force: args.force === true,
            deleteBranch: args.deleteBranch === true,
          })
          return {
            text: removal.branchDeleted
              ? `Removed ${removal.anchor.branch} and its branch.`
              : `Removed ${removal.anchor.branch}; the branch is still there.`
              + (removal.branchError === undefined ? '' : `\nThe branch could not be deleted: ${removal.branchError}`),
          }
        } catch (error) {
          return { text: failure(error) }
        }
      },
    }))
  })
}
