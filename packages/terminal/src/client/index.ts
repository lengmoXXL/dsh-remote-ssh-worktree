/**
 * The browser half of dsh-terminal.
 *
 * It contributes one right-Sidebar tab type, registered exactly the way the
 * Files panel registers its own: a page type with a guide capsule, so the
 * column's add control lists a Terminal button beside the others, and a body
 * under the same id that draws it. There is no address to claim — a terminal is
 * per Session, not per file — so the type carries no patterns and opens by
 * kind.
 *
 * Every Harness import here is `import type`: the browser bundle shares the
 * shell's React and its `@deepseek-ai/*` modules through the loader's `require`,
 * and a value import from anything but the primitives package would need a
 * module the loader does not hand it.
 *
 * @module dsh-terminal/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard seat (sessionId) the tab bodies receive.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the tab registry merge (ctx.sidebarRightTabs) and its seats.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { TERMINAL_ID, TERMINAL_KIND } from '../shared/wire.ts'
import { en, NS, zh, type TerminalKey } from './locales.ts'
import { TerminalBody } from './TerminalBody.tsx'
import { TerminalGlyph } from './glyphs.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Terminal tab, guide, and status copy. */
    'dsh-terminal': TerminalKey
  }
}

/** Client plugin name used by the loader and by diagnostics. */
export const name = 'dsh-terminal-ui'

/** Client services this plugin needs before it activates. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * The terminal type's static face, including the guide entry the add control
 * lists.
 * @param t - the namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
function terminalDefinition(t: Translate<TerminalKey>): SidebarRightTabDefinition {
  return {
    id: TERMINAL_ID,
    kind: TERMINAL_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      order: 30,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: TerminalGlyph,
    }],
  }
}

/**
 * Mount the client half.
 * @param ctx - the client context this plugin was mounted on.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-terminal: dictionaries')
  // Bound, not called: every label is read through it at draw time, so a
  // language change needs no re-registration.
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.sidebarRightTabs.register(terminalDefinition(t)), 'dsh-terminal: type')
  // Stage two of the type: the body registers under the definition's id.
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TERMINAL_ID, locale: NS },
    TerminalBody,
  )), 'dsh-terminal: body')
}
