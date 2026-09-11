/**
 * The Remote worktrees settings section.
 *
 * The section renders one tree: a machine, the repositories registered on it,
 * and the worktrees cut from each repository. Every level is a fold, so the
 * whole deployment is legible at once and any single branch can be worked on
 * without losing sight of the rest.
 *
 * The component is a function of the four prop shares: data it fetches for
 * itself lives in local state, every mutation arrives as an injected callback,
 * every string comes from the locale seat, and no value reaches for `ctx`.
 *
 * @module dsh-remote-worktree/client/Section
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Button,
  DisclosureRow,
  IconBranchOutline16,
  IconChevronLeftOutline14,
  IconFolderOpen16,
  IconGlobeOutline14,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconRightUpOutline16,
  IconTrashOutline16,
  IconWarningOutline16,
  Input,
  Modal,
  StateDot,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteWorktreesKey } from './locales.ts'
import { NS } from './locales.ts'
import css from './Section.module.css'

/** The locale seat this section reads, including its template parameters. */
type T = (key: RemoteWorktreesKey, params?: Record<string, unknown>) => string

/** How the host reaches a machine's daemon. */
interface NodeTransport {
  readonly kind: 'ssh'
  readonly target: string
  readonly sshPort?: number
  readonly identityFile?: string
}

/** One machine as the host projects it. */
interface NodeView {
  readonly nodeId: string
  readonly title: string
  readonly transport: NodeTransport
  readonly remotePort: number
  readonly hasToken: boolean
}

/** The connection states a machine can report. */
type NodeState = 'idle' | 'connecting' | 'ready' | 'failed' | 'disconnected'

/** One machine's connection state. */
interface NodeStatus {
  readonly nodeId: string
  readonly state: NodeState
  /** The local port carrying this machine's traffic, once a forward is up. */
  readonly localPort?: number
  readonly error?: string
}

/** One registered repository. */
interface RepoRecord {
  readonly repoId: string
  readonly nodeId: string
  readonly repoPath: string
  readonly name: string
}

/** Live state of a checkout. */
interface RepoState {
  readonly branch: string | null
  readonly clean: boolean
}

/** One repository with the live state read from its machine. */
interface RepoReport {
  readonly repo: RepoRecord
  readonly state?: RepoState
  readonly error?: string
}

/** One local anchor. */
interface AnchorRecord {
  readonly anchorId: string
  readonly nodeId: string
  readonly repoPath: string
  readonly name: string
  readonly branch: string
  readonly anchorPath: string
  readonly remoteRoot: string
}

/** One worktree joined with its repository's live state. */
interface WorktreeStatus {
  readonly anchor: AnchorRecord
  readonly repo?: RepoState
  readonly error?: string
}

/** One entry of a remote directory listing. */
interface DirEntry {
  readonly name: string
  readonly type: string
  readonly path: string
}

/** One remote directory level. */
export interface DirListing {
  readonly path: string
  readonly entries: readonly DirEntry[]
}

/** Everything the section reads in one refresh. */
export interface Snapshot {
  readonly nodes: readonly NodeView[]
  readonly statuses: readonly NodeStatus[]
  readonly repos: readonly RepoReport[]
  readonly worktrees: readonly WorktreeStatus[]
}

/** The callbacks the section drives. */
export interface RemoteWorktreesFace {
  /** Read machines, repositories, and worktrees with their live state. */
  load(): Promise<Snapshot>
  /** Add a machine. */
  addNode(draft: {
    ssh: { target: string; port?: number; identityFile?: string }
    remotePort: number
    token: string
    title?: string
  }): Promise<void>
  /** Remove a machine and its repository registrations. */
  removeNode(nodeId: string): Promise<void>
  /** Open a connection to a machine. */
  connectNode(nodeId: string): Promise<void>
  /** Close a machine's connection. */
  disconnectNode(nodeId: string): Promise<void>
  /** Register a repository on a machine. */
  addRepo(draft: { nodeId: string; repoPath: string; name?: string }): Promise<void>
  /** Drop a repository registration. */
  removeRepo(repoId: string): Promise<void>
  /** List one directory level on a machine. */
  listDirs(nodeId: string, path: string): Promise<DirListing>
  /** Cut a worktree from a registered repository. */
  createWorktree(draft: { repoId: string; name: string }): Promise<void>
  /** Remove a worktree and its branch. */
  removeWorktree(anchorId: string): Promise<void>
  /** Merge a worktree's branch back into its repository. */
  bringBack(anchorId: string): Promise<void>
}

/** Props the shell composes for this section. */
type SectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<typeof NS>
  & InjectFace<RemoteWorktreesFace>

/** A pending destructive action the user must confirm. */
interface Confirmation {
  readonly titleKey: RemoteWorktreesKey
  readonly bodyKey: RemoteWorktreesKey
  readonly run: () => Promise<void>
}

/** Which dialog is open, if any. */
type Dialog =
  | { readonly kind: 'machine' }
  | { readonly kind: 'repo'; readonly nodeId: string }
  | { readonly kind: 'worktree'; readonly repo: RepoRecord }
  | undefined

/** The state dot and label one connection state renders as. */
function statusOf(state: NodeState): {
  dot: 'done' | 'ongoing' | 'error' | 'idle'
  key: RemoteWorktreesKey
} {
  if (state === 'ready') return { dot: 'done', key: 'status.ready' }
  if (state === 'connecting') return { dot: 'ongoing', key: 'status.connecting' }
  if (state === 'failed') return { dot: 'error', key: 'status.failed' }
  if (state === 'disconnected') return { dot: 'idle', key: 'status.disconnected' }
  return { dot: 'idle', key: 'status.idle' }
}

/** The message a failure carries, or a readable fallback. */
function reasonOf(failure: unknown): string {
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

/** The live branch and cleanliness of one repository. */
function RepoFacts({ state, error, t }: {
  state: RepoState | undefined
  error: string | undefined
  t: T
}) {
  if (state === undefined) {
    return <span className={css.dim}>{error ?? '—'}</span>
  }
  return (
    <>
      <Tag tone="quiet">{state.branch ?? t('detached')}</Tag>
      <Tag tone={state.clean ? 'success' : 'warning'}>{state.clean ? t('clean') : t('dirty')}</Tag>
    </>
  )
}

/**
 * Add a machine by its SSH destination.
 *
 * The host opens the forward itself, so the operator never picks a local port
 * and never runs `ssh -L` by hand. The token is the remote daemon's own secret,
 * which the operator started it with.
 */
function AddMachineDialog({ open, busy, onClose, onSubmit, t }: {
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (draft: {
    ssh: { target: string; port?: number; identityFile?: string }
    remotePort: number
    token: string
    title?: string
  }) => Promise<void>
  t: T
}) {
  const [target, setTarget] = useState('')
  const [sshPort, setSshPort] = useState('')
  const [identityFile, setIdentityFile] = useState('')
  const [remotePort, setRemotePort] = useState('7801')
  const [token, setToken] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    setTarget('')
    setSshPort('')
    setIdentityFile('')
    setRemotePort('7801')
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
        remotePort: Number(remotePort),
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
            disabled={busy || target.trim() === '' || token.trim() === '' || remotePort.trim() === ''}
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
          <Input value={target} placeholder="user@build-01" onChange={e => setTarget(e.target.value)} />
        </Field>
        <Field label={`${t('fieldSshPort')} · ${t('optional')}`} hint={t('hintSshPort')}>
          <Input value={sshPort} inputMode="numeric" onChange={e => setSshPort(e.target.value)} />
        </Field>
        <Field label={`${t('fieldIdentityFile')} · ${t('optional')}`} hint={t('hintIdentityFile')}>
          <Input value={identityFile} placeholder="~/.ssh/id_ed25519" onChange={e => setIdentityFile(e.target.value)} />
        </Field>
        <Field label={t('fieldRemotePort')} hint={t('hintRemotePort')}>
          <Input value={remotePort} inputMode="numeric" onChange={e => setRemotePort(e.target.value)} />
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
  nodeId: string
  value: string
  onChange: (path: string) => void
  listDirs: (nodeId: string, path: string) => Promise<DirListing>
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
function AddRepoDialog({ open, nodeId, busy, onClose, onSubmit, listDirs, t }: {
  open: boolean
  nodeId: string
  busy: boolean
  onClose: () => void
  onSubmit: (draft: { nodeId: string; repoPath: string; name?: string }) => Promise<void>
  listDirs: (nodeId: string, path: string) => Promise<DirListing>
  t: T
}) {
  const [repoPath, setRepoPath] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    setRepoPath('')
    setName('')
    setError(undefined)
  }, [open])

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
      open={open}
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
          <Input value={repoPath} onChange={e => setRepoPath(e.target.value)} placeholder="/workspace/project" />
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

/** Cut a worktree from a registered repository. */
function NewWorktreeDialog({ open, repo, busy, onClose, onSubmit, t }: {
  open: boolean
  repo: RepoRecord | undefined
  busy: boolean
  onClose: () => void
  onSubmit: (draft: { repoId: string; name: string }) => Promise<void>
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
          <Input value={name} placeholder="feature-x" onChange={e => setName(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/**
 * One worktree row inside an expanded repository.
 *
 * The row names the checkout and the branch it is on. It deliberately does not
 * repeat the repository's branch and cleanliness from the row above: that state
 * belongs to the main checkout, not to this worktree, so showing it here would
 * duplicate a fact and misattribute it.
 *
 * The two actions are icon-only because the settings column is narrow and a
 * labelled pair wraps in it; each keeps its name for assistive technology and
 * for hover.
 */
function WorktreeRow({ entry, busy, onRemove, onBringBack, t }: {
  entry: WorktreeStatus
  busy: boolean
  onRemove: () => void
  onBringBack: () => void
  t: T
}) {
  return (
    <div className={css.worktree}>
      <IconBranchOutline16 />
      <span className={css.worktreeMain}>
        <span className={css.worktreeName}>{entry.anchor.name}</span>
        <span className={css.meta}>{entry.anchor.branch}</span>
        {entry.error === undefined ? null : <span className={css.dim}>{entry.error}</span>}
      </span>
      <span className={css.trailing}>
        <Button
          size="sm"
          icon={<IconRightUpOutline16 />}
          disabled={busy}
          aria-label={t('bringBack')}
          title={t('bringBack')}
          onClick={onBringBack}
        />
        <Button
          size="sm"
          icon={<IconTrashOutline16 />}
          disabled={busy}
          aria-label={t('removeWorktree')}
          title={t('removeWorktree')}
          onClick={onRemove}
        />
      </span>
    </div>
  )
}

/**
 * The Remote worktrees settings section.
 * @param props - the owner share, the locale seat, and the injected face.
 * @returns the section element.
 */
export function RemoteWorktreesSection(props: SectionProps) {
  const { t } = props
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(undefined)
  const [confirmation, setConfirmation] = useState<Confirmation | undefined>(undefined)
  const [openMachines, setOpenMachines] = useState<readonly string[]>([])
  const [openRepos, setOpenRepos] = useState<readonly string[]>([])

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await props.load())
      setError(undefined)
    } catch (failure) {
      setError(reasonOf(failure))
    }
  }, [props])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Run one mutation, then re-read; a failure lands in the banner. */
  const mutate = useCallback(async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
      setError(undefined)
      await refresh()
    } catch (failure) {
      setError(reasonOf(failure))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  /** Run a dialog's mutation; the dialog shows the failure itself. */
  const submit = useCallback(async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const toggle = (
    list: readonly string[],
    set: (next: readonly string[]) => void,
    id: string,
  ): void => {
    set(list.includes(id) ? list.filter(entry => entry !== id) : [...list, id])
  }

  const statusFor = (nodeId: string): NodeStatus | undefined =>
    snapshot?.statuses.find(status => status.nodeId === nodeId)
  const reposOf = (nodeId: string): readonly RepoReport[] =>
    (snapshot?.repos ?? []).filter(entry => entry.repo.nodeId === nodeId)
  const worktreesOf = (repo: RepoRecord): readonly WorktreeStatus[] =>
    (snapshot?.worktrees ?? []).filter(entry =>
      entry.anchor.nodeId === repo.nodeId && entry.anchor.repoPath === repo.repoPath)

  const confirm = (next: Confirmation): void => setConfirmation(next)

  const nodes = snapshot?.nodes ?? []

  return (
    <div className={css.section}>
      <div className={css.head}>
        <h3 className={css.title}>{t('title')}</h3>
        <p className={css.subtitle}>{t('subtitle')}</p>
      </div>

      <div className={css.toolbar}>
        <Button
          variant="outline"
          icon={<IconPlusOutline16 />}
          disabled={busy}
          onClick={() => setDialog({ kind: 'machine' })}
        >
          {t('addMachine')}
        </Button>
        <Button icon={<IconRefreshOutline16 />} disabled={busy} onClick={() => void refresh()}>
          {t('refresh')}
        </Button>
      </div>

      {error === undefined ? null : (
        <div className={css.alert} role="alert">
          <IconWarningOutline16 />
          <span>{error}</span>
        </div>
      )}

      {snapshot === undefined ? (
        <div className={css.empty}>{t('loading')}</div>
      ) : nodes.length === 0 ? (
        <div className={css.empty}>{t('machinesEmpty')}</div>
      ) : (
        <div className={css.tree}>
          {nodes.map(node => {
            const status = statusFor(node.nodeId)
            const state = status?.state ?? 'idle'
            const badge = statusOf(state)
            const machineOpen = openMachines.includes(node.nodeId)
            const repos = reposOf(node.nodeId)
            return (
              <div key={node.nodeId} className={css.card}>
                <DisclosureRow
                  icon={<IconGlobeOutline14 />}
                  title={node.title}
                  open={machineOpen}
                  expandable
                  expandOnRowClick
                  keepContentWhenOpen
                  rowClassName={css.row}
                  leadingClassName={css.leading}
                  onToggle={() => toggle(openMachines, setOpenMachines, node.nodeId)}
                  collapsedContent={(
                    <span className={css.trailing}>
                      <span className={css.meta}>{node.transport.target}</span>
                      {status?.localPort === undefined
                        ? null
                        : <Tag tone="neutral">{t('forwarding', { port: status.localPort })}</Tag>}
                      {node.hasToken ? null : <Tag tone="warning">{t('noToken')}</Tag>}
                      <StateDot state={badge.dot} />
                      <span className={css.meta}>{t(badge.key)}</span>
                    </span>
                  )}
                >
                  <div className={css.actions}>
                    {state === 'ready'
                      ? (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void mutate(() => props.disconnectNode(node.nodeId))}
                        >
                          {t('disconnect')}
                        </Button>
                      )
                      : (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void mutate(() => props.connectNode(node.nodeId))}
                        >
                          {t('connect')}
                        </Button>
                      )}
                    <Button
                      size="sm"
                      icon={<IconPlusOutline16 />}
                      disabled={busy}
                      onClick={() => setDialog({ kind: 'repo', nodeId: node.nodeId })}
                    >
                      {t('addRepository')}
                    </Button>
                    <Button
                      size="sm"
                      icon={<IconTrashOutline16 />}
                      disabled={busy}
                      onClick={() => confirm({
                        titleKey: 'removeMachineTitle',
                        bodyKey: 'removeMachineBody',
                        run: () => props.removeNode(node.nodeId),
                      })}
                    >
                      {t('removeMachine')}
                    </Button>
                  </div>
                  <div className={css.repos}>
                    {repos.length === 0
                      ? <div className={css.empty}>{t('repositoriesEmpty')}</div>
                      : repos.map(entry => {
                        const repo = entry.repo
                        const repoOpen = openRepos.includes(repo.repoId)
                        const worktrees = worktreesOf(repo)
                        return (
                          <div key={repo.repoId} className={css.repoCard}>
                            <DisclosureRow
                              icon={<IconFolderOpen16 />}
                              title={repo.name}
                              open={repoOpen}
                              expandable
                              expandOnRowClick
                              keepContentWhenOpen
                              rowClassName={css.row}
                              leadingClassName={css.leading}
                              onToggle={() => toggle(openRepos, setOpenRepos, repo.repoId)}
                              collapsedContent={(
                                <span className={css.trailing}>
                                  <RepoFacts state={entry.state} error={entry.error} t={t} />
                                </span>
                              )}
                            >
                              <div className={css.actions}>
                                <Button
                                  size="sm"
                                  icon={<IconPlusOutline16 />}
                                  disabled={busy}
                                  onClick={() => setDialog({ kind: 'worktree', repo })}
                                >
                                  {t('newWorktree')}
                                </Button>
                                <Button
                                  size="sm"
                                  icon={<IconTrashOutline16 />}
                                  disabled={busy}
                                  onClick={() => confirm({
                                    titleKey: 'removeRepositoryTitle',
                                    bodyKey: 'removeRepositoryBody',
                                    run: () => props.removeRepo(repo.repoId),
                                  })}
                                >
                                  {t('forgetRepository')}
                                </Button>
                              </div>
                              <div className={css.worktrees}>
                                {worktrees.length === 0
                                  ? <div className={css.empty}>{t('worktreesEmpty')}</div>
                                  : worktrees.map(item => (
                                    <WorktreeRow
                                      key={item.anchor.anchorId}
                                      entry={item}
                                      busy={busy}
                                      t={t}
                                      onBringBack={() => void mutate(() => props.bringBack(item.anchor.anchorId))}
                                      onRemove={() => confirm({
                                        titleKey: 'removeWorktreeTitle',
                                        bodyKey: 'removeWorktreeBody',
                                        run: () => props.removeWorktree(item.anchor.anchorId),
                                      })}
                                    />
                                  ))}
                              </div>
                            </DisclosureRow>
                          </div>
                        )
                      })}
                  </div>
                </DisclosureRow>
              </div>
            )
          })}
        </div>
      )}

      <AddMachineDialog
        open={dialog?.kind === 'machine'}
        busy={busy}
        onClose={() => setDialog(undefined)}
        onSubmit={draft => submit(() => props.addNode(draft))}
        t={t}
      />

      <AddRepoDialog
        open={dialog?.kind === 'repo'}
        nodeId={dialog?.kind === 'repo' ? dialog.nodeId : ''}
        busy={busy}
        onClose={() => setDialog(undefined)}
        onSubmit={draft => submit(() => props.addRepo(draft))}
        listDirs={props.listDirs}
        t={t}
      />

      <NewWorktreeDialog
        open={dialog?.kind === 'worktree'}
        repo={dialog?.kind === 'worktree' ? dialog.repo : undefined}
        busy={busy}
        onClose={() => setDialog(undefined)}
        onSubmit={draft => submit(() => props.createWorktree(draft))}
        t={t}
      />

      <Modal
        open={confirmation !== undefined}
        onClose={() => setConfirmation(undefined)}
        title={confirmation === undefined ? '' : t(confirmation.titleKey)}
        closeLabel={t('close')}
        footer={(
          <>
            <Button onClick={() => setConfirmation(undefined)}>{t('cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                const pending = confirmation
                setConfirmation(undefined)
                if (pending !== undefined) void mutate(pending.run)
              }}
            >
              {t('remove')}
            </Button>
          </>
        )}
      >
        <div className={css.confirm}>
          <p className={css.subtitle}>
            {confirmation === undefined ? null : t(confirmation.bodyKey)}
          </p>
        </div>
      </Modal>
    </div>
  )
}
