/**
 * The stylesheet the settings section installs once per document.
 *
 * A dynamic client bundle is a single CommonJS factory the shell evaluates; it
 * has no stylesheet channel, and this plugin's build does not run the CSS
 * pipeline the in-repo client preset provides. The rules therefore travel as a
 * string behind a `drw-` class prefix and are attached to the document the
 * first time the section mounts.
 *
 * Every value is a semantic `--dsw-*` alias, never a literal colour, so the
 * section follows the shell's light and dark themes without a second palette.
 *
 * @module dsh-remote-worktree/client/styles
 */

/** Attribute marking the one `<style>` element this plugin owns. */
const STYLE_ATTRIBUTE = 'data-plugin-css'

/** The plugin id the style element is keyed by. */
const STYLE_ID = 'dsh-remote-worktree'

/** Class names the section's markup uses. */
export const CLASS = {
  section: 'drw-section',
  head: 'drw-head',
  title: 'drw-title',
  subtitle: 'drw-subtitle',
  toolbar: 'drw-toolbar',
  alert: 'drw-alert',
  empty: 'drw-empty',
  tree: 'drw-tree',
  row: 'drw-row',
  leading: 'drw-leading',
  card: 'drw-card',
  trailing: 'drw-trailing',
  meta: 'drw-meta',
  dim: 'drw-dim',
  path: 'drw-path',
  repos: 'drw-repos',
  repoCard: 'drw-repo-card',
  worktrees: 'drw-worktrees',
  worktree: 'drw-worktree',
  worktreeMain: 'drw-worktree-main',
  worktreeName: 'drw-worktree-name',
  actions: 'drw-actions',
  fields: 'drw-fields',
  field: 'drw-field',
  label: 'drw-label',
  hint: 'drw-hint',
  picker: 'drw-picker',
  pickerBar: 'drw-picker-bar',
  pickerPath: 'drw-picker-path',
  pickerList: 'drw-picker-list',
  pickerItem: 'drw-picker-item',
  pickerEmpty: 'drw-picker-empty',
  confirm: 'drw-confirm',
} as const

const CSS = `
.${CLASS.section} {
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 13px;
}
.${CLASS.head} { display: flex; flex-direction: column; gap: 6px; }
.${CLASS.title} { margin: 0; font-size: 14px; font-weight: 600; }
.${CLASS.subtitle} {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.55;
}
.${CLASS.toolbar} { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.${CLASS.alert} {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}
.${CLASS.empty} {
  padding: 10px 4px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.55;
}
.${CLASS.tree} { display: flex; flex-direction: column; gap: 8px; }
.${CLASS.card} {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.${CLASS.trailing} {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
  /* Keeps the cluster off the title however short the title is. */
  padding-left: 14px;
  /* A leading title truncates before the status or an action is squeezed. */
  flex: 0 0 auto;
}
/* The shared disclosure row is a 24px line built for dense list rows. A
   machine or repository header carries a status cluster, so it gets the height
   and the horizontal room that cluster needs. */
/* Scoped under the card so these rules outrank the primitive's own module
   classes regardless of which stylesheet the document received last. */
.${CLASS.card} .${CLASS.row} {
  height: auto;
  min-height: calc(28px + var(--dsh-content-font-delta, 0px));
  /* Horizontal padding belongs on the row: without it the status cluster ends
     flush against the card border while the leading glyph only looks inset. */
  padding: 3px 12px;
}
/* The shared row is built for dense lists and leaves 6px between the glyph and
   the title; a header in this tree reads better with more. */
.${CLASS.card} .${CLASS.leading} {
  margin-right: 8px;
}
.${CLASS.meta} {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.${CLASS.dim} { color: var(--dsw-alias-label-dimmed); font-size: 12px; }
.${CLASS.path} {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  word-break: break-all;
}
.${CLASS.repos} {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px 10px 22px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.${CLASS.repoCard} {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  overflow: hidden;
}
.${CLASS.worktrees} {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 12px 8px 22px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.${CLASS.worktree} {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 8px;
  border-radius: 6px;
}
.${CLASS.worktree}:hover { background: var(--dsw-alias-interactive-bg-hover); }
.${CLASS.worktreeMain} { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.${CLASS.worktreeName} {
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
}
.${CLASS.actions} { display: flex; align-items: center; gap: 8px; padding: 7px 12px; flex-wrap: wrap; }
.${CLASS.fields} { display: flex; flex-direction: column; gap: 12px; }
.${CLASS.field} { display: flex; flex-direction: column; gap: 6px; }
.${CLASS.label} { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.${CLASS.hint} { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }
.${CLASS.picker} { display: flex; flex-direction: column; gap: 8px; }
.${CLASS.pickerBar} { display: flex; align-items: center; gap: 8px; }
.${CLASS.pickerPath} {
  flex: 1;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}
.${CLASS.pickerList} {
  display: flex;
  flex-direction: column;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.${CLASS.pickerItem} {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.${CLASS.pickerItem}:hover { background: var(--dsw-alias-interactive-bg-hover); }
.${CLASS.pickerEmpty} { padding: 14px 10px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.${CLASS.confirm} { display: flex; flex-direction: column; gap: 12px; }
`

/**
 * Attach this plugin's stylesheet to a document, once.
 * @param doc - the document to install into.
 */
export function installStyles(doc: Document): void {
  if (doc.querySelector(`style[${STYLE_ATTRIBUTE}=${JSON.stringify(STYLE_ID)}]`) !== null) return
  const tag = doc.createElement('style')
  tag.setAttribute(STYLE_ATTRIBUTE, STYLE_ID)
  tag.textContent = CSS
  doc.head.append(tag)
}
