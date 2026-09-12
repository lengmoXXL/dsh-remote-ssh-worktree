/**
 * The three editors the section opens, and the bits they share with it.
 *
 * Each editor is a form over an injected callback: it collects input, reports
 * its own failure text, and never talks to the host itself. The form field, the
 * in-dialog failure line, the parent-directory helper, and the failure-text
 * helper live here because only these editors and the section that opens them
 * render with them.
 *
 * @module dsh-remote-ssh-worktree/plugin/client/dialogs
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Button,
  IconChevronLeftOutline14,
  IconFolderOpen16,
  IconWarningOutline16,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { NodeId, RepoId } from '../../ids.ts'
import type { DirListing, RepoRecord, T } from './Section.tsx'
import css from './Section.module.css'

/** The message a failure carries, or a readable fallback. */
export function reasonOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** A labelled form field. */
function Field({ label, hint, children }: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className={css.field}>
      <span className={css.label}>{label}</span>
      {children}
      {hint === undefined ? null : <span className={css.hint}>{hint}</span>}
    </div>
  )
}
/** A failure shown inside a dialog, where the global banner is out of view. */
function DialogError({ message }: { message: string | undefined }) {
  if (message === undefined) return null
  return (
    <div className={css.alert}>
      <IconWarningOutline16 />
      <span>{message}</span>
    </div>
  )
}
/**
 * Add a machine by its SSH destination.
 *
 * The host installs and starts the agent itself, so the operator picks no port
 * and never runs `ssh -L` by hand. The token is the shared secret the plugin
 * gives that agent.
 */
export function AddMachineDialog({ open, busy, onClose, onSubmit, t }: {
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (draft: {
    ssh: { target: string; port?: number; identityFile?: string }
    token: string
    title?: string
  }) => Promise<void>
  t: T
}) {
  const [target, setTarget] = useState('')
  const [sshPort, setSshPort] = useState('')
  const [identityFile, setIdentityFile] = useState('')
  const [token, setToken] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    setTarget('')
    setSshPort('')
    setIdentityFile('')
    setToken('')
    setTitle('')
    setError(undefined)
  }, [open])

  const submit = async (): Promise<void> => {
    setError(undefined)
    try {
      await onSubmit({
        ssh: {
          target: target.trim(),
          ...sshPort.trim() === '' ? {} : { port: Number(sshPort) },
          ...identityFile.trim() === '' ? {} : { identityFile: identityFile.trim() },
        },
        token,
        ...title.trim() === '' ? {} : { title: title.trim() },
      })
      onClose()
    } catch (failure) {
      setError(reasonOf(failure))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('addMachine')}
      closeLabel={t('close')}
      footer={(
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="primary"
            disabled={busy || target.trim() === '' || token.trim() === ''}
            onClick={() => void submit()}
          >
            {t('create')}
          </Button>
        </>
      )}
    >
      <div className={css.fields}>
        <DialogError message={error} />
        <Field label={t('fieldTarget')} hint={t('hintTarget')}>
          <Input value={target} placeholder={t('placeholderTarget')} onChange={e => setTarget(e.target.value)} />
        </Field>
        <Field label={`${t('fieldSshPort')} · ${t('optional')}`} hint={t('hintSshPort')}>
          <Input value={sshPort} inputMode="numeric" onChange={e => setSshPort(e.target.value)} />
        </Field>
        <Field label={`${t('fieldIdentityFile')} · ${t('optional')}`} hint={t('hintIdentityFile')}>
          <Input value={identityFile} placeholder={t('placeholderIdentityFile')} onChange={e => setIdentityFile(e.target.value)} />
        </Field>
        <Field label={t('fieldToken')} hint={t('hintToken')}>
          <Input type="password" value={token} onChange={e => setToken(e.target.value)} />
        </Field>
        <Field label={`${t('fieldName')} · ${t('optional')}`}>
          <Input value={title} onChange={e => setTitle(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
/**
 * Browse one machine's directories and pick a repository root.
 *
 * The listing comes from the same remote filesystem the agent's tools use, so
 * what the picker shows is what a session opened on the result would see.
 */
function DirectoryPicker({ nodeId, value, onChange, listDirs, t }: {
  nodeId: NodeId
  value: string
  onChange: (path: string) => void
  listDirs: (nodeId: NodeId, path: string) => Promise<DirListing>
  t: T
}) {
  const [listing, setListing] = useState<DirListing | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)

  const browse = useCallback(async (path: string) => {
    setLoading(true)
    setError(undefined)
    try {
      const next = await listDirs(nodeId, path)
      setListing(next)
      onChange(next.path)
    } catch (failure) {
      setError(reasonOf(failure))
      setListing(undefined)
    } finally {
      setLoading(false)
    }
  }, [listDirs, nodeId, onChange])

  useEffect(() => {
    void browse(value.trim() === '' ? '~' : value)
    // Opening the dialog browses the starting path exactly once; later loads
    // are driven by the picker's own controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browse])

  const entries = (listing?.entries ?? []).filter(entry => entry.type === 'directory')
  const parent = listing === undefined ? undefined : parentOf(listing.path)

  return (
    <div className={css.picker}>
      <div className={css.pickerBar}>
        <Button
          size="sm"
          icon={<IconChevronLeftOutline14 />}
          disabled={loading || parent === undefined}
          onClick={() => { if (parent !== undefined) void browse(parent) }}
        >
          {t('pickerUp')}
        </Button>
        <span className={css.pickerPath} title={listing?.path ?? value}>{listing?.path ?? value}</span>
        <Button size="sm" disabled={loading || listing === undefined} onClick={() => { if (listing !== undefined) onChange(listing.path) }}>
          {t('pickerUse')}
        </Button>
      </div>
      <DialogError message={error} />
      <div className={css.pickerList}>
        {entries.length === 0
          ? <div className={css.pickerEmpty}>{loading ? t('loading') : t('pickerEmpty')}</div>
          : entries.map(entry => (
            <button
              key={entry.path}
              type="button"
              className={css.pickerItem}
              onClick={() => void browse(entry.path)}
            >
              <IconFolderOpen16 />
              <span>{entry.name}</span>
            </button>
          ))}
      </div>
    </div>
  )
}
/** The parent of an absolute POSIX directory, or undefined at the root. */
function parentOf(path: string): string | undefined {
  if (path === '/' || path === '') return undefined
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  if (cut < 0) return undefined
  return cut === 0 ? '/' : path.slice(0, cut)
}
/** Register a repository on a machine. */
export function AddRepoDialog({ nodeId, busy, onClose, onSubmit, listDirs, t }: {
  nodeId: NodeId
  busy: boolean
  onClose: () => void
  onSubmit: (draft: { nodeId: NodeId; repoPath: string; name?: string }) => Promise<void>
  listDirs: (nodeId: NodeId, path: string) => Promise<DirListing>
  t: T
}) {
  const [repoPath, setRepoPath] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  const submit = async (): Promise<void> => {
    setError(undefined)
    try {
      await onSubmit({
        nodeId,
        repoPath: repoPath.trim(),
        ...name.trim() === '' ? {} : { name: name.trim() },
      })
      onClose()
    } catch (failure) {
      setError(reasonOf(failure))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('addRepository')}
      closeLabel={t('close')}
      footer={(
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy || repoPath.trim() === ''} onClick={() => void submit()}>
            {t('create')}
          </Button>
        </>
      )}
    >
      <div className={css.fields}>
        <DialogError message={error} />
        <Field label={t('fieldRepository')} hint={t('hintRepository')}>
          <Input value={repoPath} onChange={e => setRepoPath(e.target.value)} placeholder={t('placeholderRepoPath')} />
        </Field>
        {repoPath.trim() === '' ? null : (
          <DirectoryPicker
            nodeId={nodeId}
            value={repoPath}
            onChange={setRepoPath}
            listDirs={listDirs}
            t={t}
          />
        )}
        <Field label={`${t('fieldName')} · ${t('optional')}`}>
          <Input value={name} onChange={e => setName(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

export function NewWorktreeDialog({ open, repo, busy, onClose, onSubmit, t }: {
  open: boolean
  repo: RepoRecord | undefined
  busy: boolean
  onClose: () => void
  onSubmit: (draft: { repoId: RepoId; name: string }) => Promise<void>
  t: T
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    setName('')
    setError(undefined)
  }, [open])

  const submit = async (): Promise<void> => {
    if (repo === undefined) return
    setError(undefined)
    try {
      await onSubmit({ repoId: repo.repoId, name: name.trim() })
      onClose()
    } catch (failure) {
      setError(reasonOf(failure))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('newWorktree')}
      {...repo === undefined ? {} : { description: repo.repoPath }}
      closeLabel={t('close')}
      footer={(
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy || name.trim() === ''} onClick={() => void submit()}>
            {t('create')}
          </Button>
        </>
      )}
    >
      <div className={css.fields}>
        <DialogError message={error} />
        <Field label={t('fieldWorktreeName')} hint={t('hintWorktreeName')}>
          <Input value={name} placeholder={t('placeholderWorktreeName')} onChange={e => setName(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
