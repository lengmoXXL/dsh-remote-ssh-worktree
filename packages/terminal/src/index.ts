/**
 * dsh-terminal — a shell in the Web GUI's right Sidebar.
 *
 * The host half owns one thing: a WebSocket that turns into a PTY. It resolves
 * the Session's workspace directory and allocates the shell through
 * `ctx.subprocess`, which is the whole remote story — a workspace routed by
 * dsh-remote-workspace is named by its local anchor path, so the routing
 * subprocess runtime resolves that path to the node and starts the shell
 * there. This plugin never asks which machine owns a directory, and with no
 * router composed every workspace is simply local.
 *
 * The terminal is deliberately not confined by the Session's sandbox mode. That
 * policy bounds what the *agent* may do; a terminal is the person's own shell,
 * started by the person, and a wrap built for this host's kernel cannot be
 * shipped to a remote node anyway.
 *
 * @module dsh-terminal
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerTerminalSocket } from './host/socket.ts'
import type { TerminalSettings } from './host/terminal.ts'
import { SOCKET_PATH } from './shared/wire.ts'

/** Plugin name used by the Loader and by diagnostics. */
export const name = 'dsh-terminal'

/** Services this plugin needs before it activates: the Session store and the process seam. */
export const inject = ['sessions', 'subprocess']

/** Deployment-varying choices for this plugin. */
export interface Config {
  /**
   * Program to run as the shell. Unset — the default — runs the machine's own
   * login shell, resolved on whichever machine owns the workspace, so one
   * deployment spanning a Mac and a Linux node starts zsh on one and bash on
   * the other.
   */
  shell?: string
  /**
   * Arguments after {@link shell}. Defaults to `['-l']`, a login shell, which
   * is what makes the user's own profile load. Ignored while `shell` is unset.
   */
  shellArgs?: string[]
  /** TERM-to-KILL grace for one terminal session, in milliseconds. Defaults to 3000. */
  graceMs?: number
}

/** Validated plugin config. Every default lives in {@link apply}. */
export const Config: z<Config> = z.object({
  shell: z.string(),
  shellArgs: z.array(z.string()),
  graceMs: z.number().step(1).min(1),
})

/** What a deployment runs when it names no shell. */
const LOGIN_SHELL_VIA_SH = ['/bin/sh', '-c', 'exec "${SHELL:-/bin/sh}" -l'] as const

/**
 * Resolve the argv this deployment starts a terminal with.
 * @param config - the validated plugin config.
 * @returns the program and its arguments.
 */
function shellArgv(config: Config): readonly string[] {
  if (config.shell === undefined || config.shell.length === 0) return LOGIN_SHELL_VIA_SH
  const args = config.shellArgs !== undefined && config.shellArgs.length > 0 ? config.shellArgs : ['-l']
  return [config.shell, ...args]
}

/**
 * Mount the plugin.
 * @param ctx - the host context this plugin was mounted on.
 * @param config - the validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const argv = shellArgv(config)
  const settings: TerminalSettings = {
    shell: argv[0]!,
    shellArgs: argv.slice(1),
    // A terminal is the only consumer here that cares, and both names are what
    // every full-screen program reads to decide what it may draw.
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    graceMs: config.graceMs ?? 3000,
  }
  registerTerminalSocket(ctx, SOCKET_PATH, settings)
}
