/**
 * The terminal tab's body.
 *
 * It owns no state a reader would recognise: the terminal, its scrollback, and
 * its socket belong to {@link mountTerminal}, which keeps them alive across the
 * mounts and unmounts this component goes through every time the strip changes
 * tab. What is left here is the frame — the measured screen and the status line
 * — plus the two things only a live body can do: measure, and offer a restart
 * once the shell is gone.
 *
 * @module dsh-terminal/client/TerminalBody
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { TerminalKey, TerminalNamespace } from './locales.ts'
import { mountTerminal, restartTerminal, terminalState, type TerminalState } from './session.ts'
import css from './TerminalBody.module.css'

/** The status line's text for one state. */
function statusText(state: TerminalState, t: Translate<TerminalKey>): string {
  switch (state.kind) {
    case 'opening':
      return t('status.opening')
    case 'live':
      return state.cwd
    case 'ended':
      return state.code === null
        ? t('status.signalled', { signal: state.signal ?? '' })
        : t('status.exited', { code: state.code })
    case 'closed':
      return t('status.disconnected')
    case 'failed':
      return t('status.failed', { message: state.message })
  }
}

/** The terminal tab's composed props: the tab seat, the Session identity, and its dictionary. */
export type TerminalBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<TerminalNamespace>

/**
 * Draw the terminal.
 * @param props - see {@link TerminalBodyProps}.
 * @returns the tab's body.
 */
export function TerminalBody({ useTabInfo, sessionId, t }: TerminalBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const screen = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<TerminalState>(() => terminalState(tab.id))

  useLayoutEffect(() => {
    const host = screen.current
    if (host === null) return
    return mountTerminal({ tabId: tab.id, sessionId, host, signal: tab.signal, onState: setState })
  }, [tab.id, tab.signal, sessionId])

  const gone = state.kind === 'ended' || state.kind === 'failed' || state.kind === 'closed'
  return (
    <div className={css.pane}>
      <div className={css.screen} ref={screen} />
      <div className={css.bar}>
        <span className={css.path} title={state.kind === 'live' ? state.cwd : undefined}>
          {statusText(state, t)}
        </span>
        {state.kind === 'live' && state.fixedSize
          ? <span className={css.note}>{t('note.fixedSize')}</span>
          : null}
        {gone
          ? (
            <Button
              className={css.action}
              size="sm"
              variant="ghost"
              onClick={() => {
                restartTerminal(tab.id)
              }}
            >
              {t('action.restart')}
            </Button>
          )
          : null}
      </div>
    </div>
  )
}
