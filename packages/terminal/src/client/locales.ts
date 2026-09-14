/**
 * Bilingual copy for the terminal panel.
 *
 * The Chinese dictionary is the key source; the English one is checked against
 * its key set, so a key added to one without the other fails the type check.
 *
 * @module dsh-terminal/client/locales
 */

/** Locale namespace owned by this plugin's Web UI. */
export const NS = 'dsh-terminal'

/** This namespace's identifier, as the shell's locale and slot seats address it. */
export type TerminalNamespace = typeof NS

/** Simplified Chinese dictionary and key source. */
export const zh = {
  'type.label': '终端',
  'guide.title': '终端',
  'guide.description': '在会话的工作区目录打开一个 shell，远程工作区则在对应机器上打开',

  'status.opening': '正在打开终端…',
  'status.failed': '终端未能打开：{message}',
  'status.exited': '终端已退出（退出码 {code}）',
  'status.signalled': '终端已退出（信号 {signal}）',
  'status.disconnected': '连接已断开',

  'note.fixedSize': '这台机器上的终端不支持调整大小',

  'action.restart': '重新打开',
}

/** Every key this namespace owns. */
export type TerminalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Terminal',
  'guide.title': 'Terminal',
  'guide.description': 'Open a shell in the session workspace — on the machine that owns it when the workspace is remote',

  'status.opening': 'Opening the terminal…',
  'status.failed': 'The terminal could not be opened: {message}',
  'status.exited': 'The terminal exited (code {code})',
  'status.signalled': 'The terminal exited (signal {signal})',
  'status.disconnected': 'The connection dropped',

  'note.fixedSize': 'Terminals on this machine cannot be resized',

  'action.restart': 'Restart',
} satisfies Record<TerminalKey, string>
