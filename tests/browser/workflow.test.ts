/**
 * The management loop, driven through Firefox against a live deployment.
 *
 * The test boots a disposable DSH instance that loads this plugin, opens the
 * shell in the Firefox installed on this machine, and walks the path an
 * operator walks: add a machine, connect it, register a repository on it, cut a
 * worktree, and remove it again.
 *
 * No model is involved anywhere: the deployment carries no credentials, and
 * every surface reached here — the settings section, the management routes, and
 * the daemon — answers without an LLM call. Every step is asserted twice where
 * it matters — once from the page and once from the state it was supposed to
 * change (the management API, the anchor directory on disk, the git repository
 * on the machine) — so a UI that renders without acting fails the test.
 *
 * Screenshots land in the instance's artifact directory and their paths are
 * printed when the run ends.
 *
 * Run: npm run test:browser
 *
 * Environment: `RWT_HEADED=1` shows the browser window instead of running
 * headless, `RWT_KEEP=1` retains the scratch deployment after stopping it,
 * `RWT_LEAVE=1` leaves the deployment running and prints its URL so an operator
 * can open the very instance the test booted, `RWT_DSH_CHECKOUT` points at a
 * different harness checkout, and `RWT_FIREFOX_BIN` at a different browser
 * binary.
 *
 * @module dsh-remote-workspace/tests/browser/workflow
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { en, zh } from '../../src/plugin/client/locales.ts'
import {
  clickByText,
  clickInDialog,
  fillDialogInput,
  fillDialogInputByPlaceholder,
  waitFor,
  waitForEnabled,
  waitForForm,
  waitForFormGone,
  waitForText,
} from './dom.ts'
import { launchFirefox, type FirefoxPage } from './firefox.ts'
import { startInstance, type E2eInstance } from './instance.ts'

const run = promisify(execFile)

/** A locale key both dictionaries carry. */
type Key = keyof typeof en

/** Escape a literal string for a regular expression. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A pattern matching the label of one control in either language. */
function anyOf(...keys: Key[]): RegExp {
  return new RegExp(keys.flatMap(key => [zh[key], en[key]]).map(escape).join('|'), 'i')
}

/** A pattern matching the whole label, so `remove` cannot match `remove machine`. */
function exact(...keys: Key[]): RegExp {
  return new RegExp(`^(?:${keys.flatMap(key => [zh[key], en[key]]).map(escape).join('|')})$`, 'i')
}

/**
 * A pattern matching the actions menu of one object.
 *
 * The trigger names the object it belongs to, which is what lets a case address
 * a row directly instead of counting buttons on the page.
 */
function menuFor(name: string): RegExp {
  const prefix = [zh.actions, en.actions].map(escape).join('|')
  return new RegExp(`^(?:${prefix}): ${escape(name)}$`, 'i')
}

/** An expression that holds when any of these labels is on screen. */
function present(...keys: Key[]): string {
  const needles = keys.flatMap(key => [zh[key], en[key]]).map(text => JSON.stringify(text)).join(',')
  return `[${needles}].some(text => document.body.innerText.includes(text))`
}

/**
 * Open one object's actions menu.
 * @param page - the page to act on.
 * @param name - the object whose row carries the menu.
 */
async function openMenu(page: FirefoxPage, name: string): Promise<void> {
  await waitForEnabled(page, menuFor(name), `the actions menu of ${name}`)
  await clickByText(page, menuFor(name))
  await waitFor(page, `document.querySelector('[role="menu"]') !== null`, 'the menu to open')
}

/** Close whichever menu is open, the way an outside pointer would. */
async function closeMenu(page: FirefoxPage): Promise<void> {
  await page.evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
  await waitFor(page, `document.querySelector('[role="menu"]') === null`, 'the menu to close')
}

/**
 * Run one action from the menu of the object whose row carries this name.
 * @param page - the page to act on.
 * @param name - the object whose row carries the menu.
 * @param key - the action's locale key.
 */
async function chooseAction(page: FirefoxPage, name: string, key: Key): Promise<void> {
  await openMenu(page, name)
  await waitForEnabled(page, exact(key), `the ${key} action`)
  await clickByText(page, exact(key))
}

/**
 * An expression that holds when every one of these labels has a control.
 *
 * A row's controls are read by their words, their hover text, or their name for
 * assistive technology, because an icon-only control carries no visible label.
 */
function controlsFor(...keys: Key[]): string {
  return keys.map(key => {
    const pair = [zh[key], en[key]].map(text => JSON.stringify(text)).join(',')
    return `[${pair}].some(label => [...document.querySelectorAll('button')]`
      + `.some(button => (button.textContent ?? '').trim() === label || button.title === label`
      + ` || button.getAttribute('aria-label') === label))`
  }).join(' && ')
}

/** The open form's controls and path field, which the picker is driven with. */
const FORM_PARTS = `
  const dialogs = [...document.querySelectorAll('[role="dialog"][aria-label]')]
  const dialog = dialogs[dialogs.length - 1]
  const field = dialog === undefined ? undefined : [...dialog.querySelectorAll('input')]
    .find(input => (input.getAttribute('placeholder') ?? '') === ${JSON.stringify(en.placeholderRepoPath)})
  const controls = dialog === undefined
    ? []
    : [...dialog.querySelectorAll('button')].map(button => (button.textContent ?? '').trim())
`

/**
 * An expression that holds when the open form's directory picker lists one
 * directory and not another, which is what a narrowed suggestion list is.
 */
function pickerShows(offered: string, absent: string): string {
  return `
    (() => {
      ${FORM_PARTS}
      return controls.includes(${JSON.stringify(offered)}) && !controls.includes(${JSON.stringify(absent)})
    })()
  `
}

/** An expression that holds when the open form's path field reads exactly one path. */
function pathFieldIs(path: string): string {
  return `
    (() => {
      ${FORM_PARTS}
      return field !== undefined && field.value === ${JSON.stringify(path)}
    })()
  `
}

/**
 * Dismiss the shell's own onboarding and beta notice until none is open.
 *
 * Clicking through them is safe: they carry no plugin state, and while one is
 * open the shell traps focus, which would keep keyboard input out of the
 * composer.
 * @param page - the page to clear.
 */
async function clearShellDialogs(page: FirefoxPage): Promise<void> {
  // The settings panel is itself a dialog, so what marks an overlay is the skip
  // control inside it, not the dialog role.
  const pending = `
    (() => {
      const skip = ${JSON.stringify(SKIP_SHELL_DIALOG.source)}
      const pattern = new RegExp(skip, 'i')
      const label = el => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()
      return [...document.querySelectorAll('[role="dialog"]')].some(dialog =>
        [...dialog.querySelectorAll('button')].some(button => pattern.test(label(button))))
    })()
  `
  for (let attempt = 0; attempt < 15; attempt++) {
    if (!await page.evaluate<boolean>(pending)) return
    await clickByText(page, SKIP_SHELL_DIALOG)
    await delay(300)
  }
  await waitFor(page, `!${pending}`, 'the shell dialogs to close')
}

/** Wait for a bounded interval. */
async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

/** Poll a path's existence until the predicate holds. */
async function waitForPath(path: string, expected: 'present' | 'absent', timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const exists = await stat(path).then(() => true, () => false)
    if (exists === (expected === 'present')) return
    if (Date.now() > deadline) throw new Error(`${path} was never ${expected}`)
    await delay(200)
  }
}

/** Read the management API. */
async function api<T>(instance: E2eInstance, path: string): Promise<T> {
  const response = await fetch(`${instance.apiBase}${path}`)
  assert.equal(response.ok, true, `${path} answered ${String(response.status)}`)
  return await response.json() as T
}

/** Poll the reported connection state of one machine. */
async function waitForState(instance: E2eInstance, state: string): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const listing = await api<{ statuses: readonly { nodeId: string; state: string }[] }>(instance, '/nodes')
    if (listing.statuses.some(entry => entry.nodeId === instance.nodeId && entry.state === state)) return
    if (Date.now() > deadline) {
      throw new Error(`machine never reported ${state}: ${JSON.stringify(listing.statuses)}`)
    }
    await delay(250)
  }
}

/** List the worktrees git knows in a repository. */
async function gitWorktrees(repoPath: string): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'])
  return stdout
}

/** List the branches git knows in a repository, by name. */
async function gitBranches(repoPath: string, pattern: string): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, 'branch', '--list', '--format=%(refname:short)', pattern])
  return stdout.trim()
}

/**
 * Wait for a branch to disappear.
 *
 * The anchor is dropped before the optional branch delete runs, so a removal
 * that also takes the branch reports its end earlier than git does.
 */
async function waitForBranchGone(repoPath: string, branch: string): Promise<void> {
  const deadline = Date.now() + 20_000
  for (;;) {
    if (await gitBranches(repoPath, branch) === '') return
    if (Date.now() > deadline) throw new Error(`branch ${branch} was never deleted`)
    await delay(200)
  }
}

/**
 * Run git in a fixture, retrying while another process holds the index lock.
 *
 * A directory that was opened as a workspace is read by the shell as well —
 * describing a workspace asks git about it — and a reader refreshes the index,
 * which takes the lock this fixture's own write needs. Losing that race is the
 * environment's timing, not the plugin's behaviour, so the fixture waits it out.
 * @param cwd - the fixture directory to run in.
 * @param args - the git arguments.
 * @throws the git failure when it is not the lock, or the lock never clears.
 */
async function gitLocked(cwd: string, args: readonly string[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run('git', [...args], { cwd })
      return
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '')
      if (attempt >= 10 || !stderr.includes('index.lock')) throw error
      await delay(200)
    }
  }
}

/** The shell's own onboarding and notice buttons, which trap focus while open. */
const SKIP_SHELL_DIALOG = /^(?:稍后配置|Configure later|继续|Continue)$/i

test('a remote worktree is created and removed through the browser', { timeout: 300_000 }, async () => {
  // Nothing is created until the guard is in place: a deployment that is built
  // outside `try` would survive a thrown test and keep two processes alive.
  let deployment: E2eInstance | undefined
  let browser: FirefoxPage | undefined
  let failure: unknown
  try {
    const instance = await startInstance()
    const page = await launchFirefox({ headed: process.env['RWT_HEADED'] === '1' })
    deployment = instance
    browser = page
    const shot = async (name: string): Promise<void> => {
      // The shell can raise its own onboarding late enough to land on top of a
      // picture, so every capture starts by clearing it. Only the shell's own
      // buttons match, so this plugin's open forms are left alone.
      await clearShellDialogs(page)
      await page.screenshot(join(instance.artifacts, `${name}.png`))
    }

    // The shell, then this plugin's section.
    await page.navigate(instance.pageUrl)
    await waitFor(page, 'document.readyState === "complete"', 'the document')
    await waitFor(page, 'document.body.innerText.length > 40', 'the shell to render')
    // A fresh DSH home opens on the shell's own onboarding — the model setup
    // dialog, then the beta notice. They trap focus while open and can render a
    // beat after the shell does, so clear them before anything that needs focus.
    await clearShellDialogs(page);
    await clickByText(page, /设置|Settings/i)
    await clearShellDialogs(page)
    await clickByText(page, anyOf('title'))
    await waitFor(page, present('addMachine', 'refresh'), 'the section toolbar')
    await waitForText(page, 'e2e daemon', 'the seeded machine row')
    await shot('01-section')

    // Add a machine through the form; the host stores it under its own id.
    // The form asks for the SSH destination, two optional SSH fields, the
    // token, and an optional title — there is no port, because the agent
    // publishes the one it bound.
    await clickByText(page, exact('addMachine'))
    await waitForForm(page, exact('addMachine'), 'the add-machine form')
    await fillDialogInput(page, 0, 'e2e@127.0.0.1')
    await fillDialogInput(page, 3, 'unused-token')
    await waitForEnabled(page, exact('create'), 'the form to accept a submission')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('addMachine'), 'the add-machine form to close')
    await waitForText(page, 'e2e@127.0.0.1', 'the machine row the form created')
    const afterAdd = await api<{ nodes: readonly { title: string }[] }>(instance, '/nodes')
    assert.ok(
      afterAdd.nodes.some(node => node.title === 'e2e@127.0.0.1'),
      'the machine reached the registry',
    )
    await shot('02-machine-added')

    // The seeded machine connects itself: the plugin brings every configured
    // machine up once it loads, so the section shows a live one with no click.
    // Opening the row is still what reveals the repository controls.
    await waitForState(instance, 'ready')
    await clickByText(page, /e2e daemon/)
    await waitFor(page, present('status.ready'), 'the machine to report itself connected')
    await waitForEnabled(page, menuFor('e2e daemon'), 'the machine actions menu to settle')
    await shot('03-connected')

    // Register the fixture repository. The path field drives the picker while
    // it is typed: a half-typed name narrows the list to what answers it, and a
    // clicked row descends into itself and lands in the field.
    //
    // A collapsed machine renders no controls, so this machine's repository
    // form is the only one on the page: the built-in local machine, which is
    // listed first, is still folded.
    await chooseAction(page, 'e2e daemon', 'addRepository')
    await waitForForm(page, exact('addRepository'), 'the add-repository form')
    await shot('04-repository-form')
    await fillDialogInputByPlaceholder(
      page, new RegExp(escape(en.placeholderRepoPath)), `${dirname(instance.repoPath)}/demo`,
    )
    await waitFor(page, pickerShows('demo-repo', 'plain-dir'), 'the list to narrow to the typed prefix')
    await shot('04b-picker-narrowed')
    await clickInDialog(page, /^demo-repo$/)
    await waitFor(page, pathFieldIs(instance.repoPath), 'the clicked directory to reach the path field')
    await waitForEnabled(page, exact('create'), 'the form to accept the repository')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('addRepository'), 'the add-repository form to close')
    await waitForText(page, 'demo-repo', 'the repository row')
    const repos = await api<{ repos: readonly { repo: { repoPath: string; name: string } }[] }>(
      instance, '/repos',
    )
    assert.ok(
      repos.repos.some(report => report.repo.repoPath === instance.repoPath),
      'the repository reached the store',
    )
    await shot('05-repository-registered')

    // Cut a worktree and check the machine actually holds it.
    await clickByText(page, /demo-repo/)
    await chooseAction(page, 'demo-repo', 'newWorktree')
    await waitForForm(page, exact('newWorktree'), 'the new-worktree form')
    // The path field is filled from the start: the name finishes it, so an
    // empty name already shows the directory the checkout goes into.
    const checkoutRoot = join(instance.userHome, '.dsh', 'worktrees', 'demo-repo')
    await waitFor(
      page,
      `[...document.querySelectorAll('[role="dialog"][aria-label] input')]`
      + `.some(input => input.value === ${JSON.stringify(`${checkoutRoot}/`)})`,
      'the checkout directory to be filled in before the name',
    )
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderWorktreeName)), 'verify')
    await waitFor(
      page,
      `[...document.querySelectorAll('[role="dialog"][aria-label] input')]`
      + `.some(input => input.value === ${JSON.stringify(join(checkoutRoot, 'verify'))})`,
      'the name to finish the default path',
    )
    await waitForEnabled(page, exact('create'), 'the form to accept the worktree')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('newWorktree'), 'the new-worktree form to close')
    await waitForText(page, 'verify', 'the worktree row')
    // A checkout the plugin cut offers both ways out, in the row's own menu:
    // closing it (which leaves the checkout) and removing it (which deletes it).
    await openMenu(page, 'verify')
    await waitFor(page, controlsFor('releaseWorktree', 'removeWorktree'), 'both row actions')
    await closeMenu(page)
    const anchor = join(
      instance.home, 'remote-worktrees', 'anchors', instance.nodeId, 'demo-repo', 'verify',
    )
    const metadata = join(anchor, '.dsh-remote-worktree.json')
    await waitForPath(metadata, 'present')
    const record = JSON.parse(await readFile(metadata, 'utf8')) as
      { anchor: { branch: string; remoteRoot: string; repoPath: string } }
    assert.equal(record.anchor.branch, 'worktree/verify')
    assert.equal(record.anchor.repoPath, instance.repoPath)
    assert.ok(
      (await gitWorktrees(instance.repoPath)).includes('worktree/verify'),
      'git on the machine lists the new checkout',
    )
    assert.ok(
      (await readFile(join(instance.userHome, '.dsh', 'worktrees', 'demo-repo', 'verify', 'README.md'), 'utf8'))
        .includes('fixture'),
      'the checkout carries the repository content',
    )
    await shot('06-worktree-created')

    // Remove it again, through the confirmation the operator sees. The branch
    // option stays off, so the checkout goes and the branch stays put.
    await chooseAction(page, 'verify', 'removeWorktree')
    await waitForForm(page, anyOf('removeWorktreeTitle'), 'the confirmation')
    await clickInDialog(page, exact('remove'))
    await waitForPath(metadata, 'absent')
    assert.ok(!(await gitWorktrees(instance.repoPath)).includes('worktree/verify'), 'the checkout is gone')
    assert.equal(
      await gitBranches(instance.repoPath, 'worktree/verify'),
      'worktree/verify',
      'the branch outlives the checkout by default',
    )
    assert.equal(
      (await api<{ worktrees: readonly unknown[] }>(instance, '/worktrees')).worktrees.length, 0,
      'the anchor store is empty again',
    )
    // The workspace entry goes with the anchor, so the sidebar cannot keep a
    // dead row pointing at a checkout that is no longer on the machine.
    await waitFor(page, `!document.body.innerText.includes('verify')`, 'the sidebar to drop the workspace')
    await shot('07-worktree-removed')

    // The same control, with the option switched on, takes the branch too. This
    // one is placed by hand: the field arrives holding the default the host
    // would use, and the caller may replace it.
    await chooseAction(page, 'demo-repo', 'newWorktree')
    await waitForForm(page, exact('newWorktree'), 'the second new-worktree form')
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderWorktreeName)), 'scratch')
    const defaultCheckout = join(instance.userHome, '.dsh', 'worktrees', 'demo-repo', 'scratch')
    await waitFor(
      page,
      `[...document.querySelectorAll('[role="dialog"][aria-label] input')]`
      + `.some(input => input.value === ${JSON.stringify(defaultCheckout)})`,
      'the default checkout path to be filled in',
    )
    const customCheckout = join(instance.userHome, 'custom-scratch')
    await fillDialogInput(page, 1, customCheckout)
    await waitForEnabled(page, exact('create'), 'the form to accept the second worktree')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('newWorktree'), 'the second new-worktree form to close')
    const scratch = join(
      instance.home, 'remote-worktrees', 'anchors', instance.nodeId, 'demo-repo', 'scratch',
    )
    await waitForPath(join(scratch, '.dsh-remote-worktree.json'), 'present')
    assert.match(
      await readFile(join(customCheckout, 'README.md'), 'utf8'),
      /fixture/,
      'the checkout landed where the caller placed it',
    )

    await chooseAction(page, 'scratch', 'removeWorktree')
    await waitForForm(page, anyOf('removeWorktreeTitle'), 'the second confirmation')
    await clickInDialog(page, anyOf('removeWorktreeBranch'))
    await clickInDialog(page, exact('remove'))
    await waitForPath(join(scratch, '.dsh-remote-worktree.json'), 'absent')
    // A checkout the plugin placed itself is removable wherever it stands,
    // which is what separates it from one adopted from the machine.
    await waitForPath(customCheckout, 'absent')
    await waitForBranchGone(instance.repoPath, 'worktree/scratch')
    await waitFor(page, `!document.body.innerText.includes('scratch')`, 'the sidebar to drop the second workspace')

    // A checkout the plugin never cut: it is adopted from the machine's own
    // list, opened as a workspace, and then closed without being touched.
    await chooseAction(page, 'demo-repo', 'adoptWorktree')
    await waitForForm(page, exact('adoptWorktree'), 'the open-worktree dialog')
    await waitForText(page, 'hand-cut', 'the hand-cut checkout to be listed')
    await clickInDialog(page, /hand-cut/)
    await waitForFormGone(page, exact('adoptWorktree'), 'the open-worktree dialog to close')
    await waitForText(page, 'hand-cut', 'the adopted row')
    // A checkout the plugin found offers both ways out as well.
    await openMenu(page, 'hand-cut')
    await waitFor(page, controlsFor('releaseWorktree', 'removeWorktree'), 'both actions on an adopted row')
    await closeMenu(page)
    await waitFor(page, `document.body.innerText.includes('hand-cut · demo-repo')`, 'the adopted workspace')
    await shot('07b-adopted-worktree')

    await chooseAction(page, 'hand-cut', 'releaseWorktree')
    await waitForForm(page, anyOf('releaseWorktreeTitle'), 'the release confirmation')
    await clickInDialog(page, exact('remove'))
    await waitFor(page, `!document.body.innerText.includes('hand-cut')`, 'the row to go')
    assert.match(
      await readFile(join(instance.root, 'remote-root', 'hand-cut', 'README.md'), 'utf8'),
      /fixture/,
      'the released checkout is still on the machine',
    )

    // The same checkout can be brought back and, this time, deleted: one the
    // plugin found on the machine is still the operator's to remove.
    await chooseAction(page, 'demo-repo', 'adoptWorktree')
    await waitForForm(page, exact('adoptWorktree'), 'the second open-worktree dialog')
    await waitForText(page, 'hand-cut', 'the checkout to be listed again')
    await clickInDialog(page, /hand-cut/)
    await waitForFormGone(page, exact('adoptWorktree'), 'the second open-worktree dialog to close')
    await waitForText(page, 'hand-cut', 'the re-adopted row')

    await chooseAction(page, 'hand-cut', 'removeWorktree')
    await waitForForm(page, anyOf('removeWorktreeTitle'), 'the remove confirmation')
    await clickInDialog(page, exact('remove'))
    await waitFor(page, `!document.body.innerText.includes('hand-cut')`, 'the deleted row to go')
    await waitForPath(join(instance.root, 'remote-root', 'hand-cut'), 'absent')

    // A directory nobody initialized registers, opens as a workspace of its
    // own, and refuses worktrees until someone makes it a repository.
    await chooseAction(page, 'e2e daemon', 'addRepository')
    await waitForForm(page, exact('addRepository'), 'the add-repository form for the plain directory')
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderRepoPath)), instance.plainDir)
    await waitForEnabled(page, exact('create'), 'the form to accept the plain directory')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('addRepository'), 'the add-repository form to close')
    await waitForText(page, 'plain-dir', 'the plain directory row')
    // Both repository rows are on screen, and the plain directory is the one
    // registered second.
    await clickByText(page, /plain-dir/)
    // The refused action says why beside itself, and only the repository
    // registered first can be cut from.
    await openMenu(page, 'plain-dir')
    await waitFor(page, present('notARepository'), 'the menu to carry the reason')
    assert.equal(
      await page.evaluate<boolean>(`
        (() => {
          const needles = ${JSON.stringify([zh.notARepository, en.notARepository])}
          const item = [...document.querySelectorAll('[role="menu"] button[role="menuitem"]')]
            .find(button => needles.some(needle => (button.textContent ?? '').includes(needle)))
          return item !== undefined && item.disabled
        })()`),
      true,
      'the plain directory refuses a worktree',
    )
    await closeMenu(page)
    await shot('08-plain-directory')

    // Opening it as a workspace asks the machine for the path and nothing else.
    await chooseAction(page, 'plain-dir', 'openWorktree')
    const plainAnchor = join(
      instance.home, 'remote-worktrees', 'anchors', instance.nodeId, 'plain-dir', '.self',
    )
    await waitForPath(join(plainAnchor, '.dsh-remote-worktree.json'), 'present')
    const opened = await api<{ worktrees: readonly { anchor: { kind: string; remoteRoot: string } }[] }>(
      instance, '/worktrees',
    )
    assert.ok(
      opened.worktrees.some(entry =>
        entry.anchor.kind === 'directory' && entry.anchor.remoteRoot === instance.plainDir),
      'the directory is open as a workspace on itself',
    )

    // Initializing it on the machine is all it takes: the next read offers
    // worktrees again, and the record is the one that was already there.
    await run('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: instance.plainDir })
    await gitLocked(instance.plainDir, [
      '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'add', '.',
    ])
    await gitLocked(instance.plainDir, [
      '-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false',
      'commit', '-m', 'initial',
    ])
    await clickByText(page, exact('refresh'))
    await shot('09-directory-initialized')

    await chooseAction(page, 'plain-dir', 'newWorktree')
    await waitForForm(page, exact('newWorktree'), 'the initialized directory form')
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderWorktreeName)), 'plain')
    await waitForEnabled(page, exact('create'), 'the form to accept the worktree')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('newWorktree'), 'the initialized directory form to close')
    assert.ok(
      (await readFile(join(instance.userHome, '.dsh', 'worktrees', 'plain-dir', 'plain', 'notes.md'), 'utf8'))
        .includes('plain'),
      'the directory that was not a repository now holds a checkout',
    )

    // This host is a machine like any other, and it needs nothing installed to
    // be one: the same form registers a repository here, and the same controls
    // cut a worktree from it. What differs is only that the checkout is a real
    // directory rather than a stand-in this plugin routes through.
    // The local machine's title is the row to click, and it leads the section:
    // once open, its controls are the first of their kind on the page.
    await clickByText(page, /^Local/)
    await chooseAction(page, 'Local', 'addRepository')
    await waitForForm(page, exact('addRepository'), 'the add-repository form for this host')
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderRepoPath)), instance.localRepo)
    await waitForEnabled(page, exact('create'), "the form to accept this host's repository")
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('addRepository'), 'the add-repository form to close')
    await waitForText(page, 'local-repo', 'the local repository row')
    const localRepos = await api<{ repos: readonly { repo: { nodeId: string; repoPath: string } }[] }>(
      instance, '/repos',
    )
    assert.ok(
      localRepos.repos.some(report => report.repo.nodeId === 'local' && report.repo.repoPath === instance.localRepo),
      'the local repository reached the store',
    )

    // The local machine leads the section, so its repository row is the first
    // one on the page once it is open.
    await clickByText(page, /local-repo/)
    await chooseAction(page, 'local-repo', 'newWorktree')
    await waitForForm(page, exact('newWorktree'), 'the local new-worktree form')
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderWorktreeName)), 'here')
    await waitForEnabled(page, exact('create'), 'the form to accept the local worktree')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('newWorktree'), 'the local new-worktree form to close')

    const localCheckout = join(instance.userHome, '.dsh', 'worktrees', 'local-repo', 'here')
    await waitForPath(join(localCheckout, 'README.md'), 'present')
    assert.match(
      await readFile(join(localCheckout, 'README.md'), 'utf8'),
      /fixture/,
      'the local checkout carries the repository content',
    )
    const localWorktrees = await api<{
      worktrees: readonly { anchor: { nodeId: string; kind: string; anchorPath: string; branch: string } }[]
    }>(instance, '/worktrees')
    const localEntry = localWorktrees.worktrees.find(entry =>
      entry.anchor.nodeId === 'local' && entry.anchor.kind === 'worktree')
    assert.equal(
      localEntry?.anchor.anchorPath,
      localCheckout,
      'the checkout is its own workspace path, with no anchor standing in for it',
    )
    assert.equal(localEntry?.anchor.branch, 'worktree/here')
    // The workspace a session would open is labelled for this machine too.
    await waitFor(page, `document.body.innerText.includes('here · local-repo · Local')`, 'the local workspace label')
    await shot('10-local-worktree')
  } catch (error) {
    failure = error
    if (browser !== undefined && deployment !== undefined) {
      await browser.screenshot(join(deployment.artifacts, 'failure.png')).catch(() => {})
      console.error('--- section text ---')
      console.error((await browser.evaluate<string>('document.body.innerText').catch(() => '(unreadable)')).slice(0, 1200))
      console.error('--- instance logs (tail) ---')
      console.error(deployment.logs().slice(-4000))
    }
    throw error
  } finally {
    await browser?.close()
    if (deployment !== undefined) {
      // Keep the pictures after the scratch directory is gone, and keep the
      // whole scratch directory when the run failed, so its logs survive.
      const gallery = join(process.cwd(), '.artifacts', 'browser')
      await mkdir(gallery, { recursive: true })
      await cp(deployment.artifacts, gallery, { recursive: true })
      const leaving = process.env['RWT_LEAVE'] === '1'
      await deployment.stop({ keep: failure !== undefined, leave: leaving })
      console.log(`screenshots: ${gallery}`)
      if (failure !== undefined) console.log(`scratch kept at ${deployment.root}`)
      if (leaving) {
        console.log(`left running: ${deployment.pageUrl}`)
        console.log(`daemon port: ${String(deployment.daemonPort)} | home: ${deployment.home}`)
        console.log(`stop it with: ${deployment.pids.map(pid => `kill -TERM -${String(pid)}`).join(' && ')}`)
      }
    }
  }
})
