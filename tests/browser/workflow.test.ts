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
 * the daemon — answers without an LLM call. Two surfaces stay out of reach by
 * construction: the `rw_*` tools, which only a model can call, and `/rwt`, which
 * is host-side and would answer without a model but can only be submitted from
 * an established session, and a fresh deployment has none — the shell creates
 * one through its first message. Both are covered by the host suites that call
 * them directly. Every step is asserted twice where it matters
 * — once from the page and once from the state it was supposed to change (the
 * management API, the anchor directory on disk, the git repository on the
 * machine) — so a UI that renders without acting fails the test.
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
 * @module dsh-remote-ssh-worktree/tests/browser/workflow
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { en, zh } from '../../src/client/locales.ts'
import {
  bodyText,
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

/** An expression that holds when any of these labels is on screen. */
function present(...keys: Key[]): string {
  const needles = keys.flatMap(key => [zh[key], en[key]]).map(text => JSON.stringify(text)).join(',')
  return `[${needles}].some(text => document.body.innerText.includes(text))`
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
    await clickByText(page, /worktree/i)
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

    // Connect the seeded machine, whose record reaches the daemon directly.
    await clickByText(page, /e2e daemon/)
    await waitForEnabled(page, exact('connect'), 'the connect control to settle')
    await clickByText(page, exact('connect'))
    await waitForState(instance, 'ready')
    await waitFor(page, present('status.ready'), 'the machine to report itself connected')
    await shot('03-connected')

    // Register the fixture repository; the daemon proves it is a git checkout.
    await clickByText(page, exact('addRepository'))
    await waitForForm(page, exact('addRepository'), 'the add-repository form')
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderRepoPath)), instance.repoPath)
    await shot('04-repository-form')
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
    await waitForEnabled(page, exact('newWorktree'), 'the worktree control to settle')
    await clickByText(page, exact('newWorktree'))
    await waitForForm(page, exact('newWorktree'), 'the new-worktree form')
    await fillDialogInputByPlaceholder(page, new RegExp(escape(en.placeholderWorktreeName)), 'verify')
    await waitForEnabled(page, exact('create'), 'the form to accept the worktree')
    await clickInDialog(page, exact('create'))
    await waitForFormGone(page, exact('newWorktree'), 'the new-worktree form to close')
    await waitForText(page, 'verify', 'the worktree row')
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
      (await readFile(join(instance.repoPath, '.dsh-worktrees', 'worktree', 'verify', 'README.md'), 'utf8'))
        .includes('fixture'),
      'the checkout carries the repository content',
    )
    await shot('06-worktree-created')

    // Remove it again, through the confirmation the operator sees.
    await waitForEnabled(page, exact('removeWorktree'), 'the worktree remove control to settle')
    await clickByText(page, exact('removeWorktree'))
    await waitForForm(page, anyOf('removeWorktreeTitle'), 'the confirmation')
    await clickInDialog(page, exact('remove'))
    await waitForPath(metadata, 'absent')
    assert.ok(!(await gitWorktrees(instance.repoPath)).includes('worktree/verify'), 'the checkout is gone')
    const branches = await run('git', ['-C', instance.repoPath, 'branch', '--list', 'worktree/verify'])
    assert.equal(branches.stdout.trim(), '', 'the branch is gone too')
    assert.equal(
      (await api<{ worktrees: readonly unknown[] }>(instance, '/worktrees')).worktrees.length, 0,
      'the anchor store is empty again',
    )
    await shot('07-worktree-removed')
  } catch (error) {
    failure = error
    if (browser !== undefined && deployment !== undefined) {
      await browser.screenshot(join(deployment.artifacts, 'failure.png')).catch(() => {})
      console.error('--- section text ---')
      console.error((await bodyText(browser).catch(() => '(unreadable)')).slice(0, 1200))
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
