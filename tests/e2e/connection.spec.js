// Losing and regaining the socket, and picking up a new build.
import { test, expect, spySocket, sentFrames, ready, fillScrollback, scrollbackCount } from './helpers.js'

test('reconnect keeps the screen up, and rejoins the same session', async ({ page }) => {
  await ready(page)
  await page.locator('#screen textarea').pressSequentially('marker')
  await expect(page.locator('#screen')).toContainText('> marker')

  await spySocket(page)

  // The socket dies but the terminal object outlives it, so the stale screen
  // stays up instead of blanking.
  await page.evaluate(() => window.afield.conn.ws.close())
  await expect(page.locator('#screen')).toContainText('> marker')

  // The server holds the session, so reconnecting lands back in it with the
  // half-typed line intact, and the screen arrives as a snapshot rather than by
  // making the program repaint. No resize is sent to get it.
  await expect(page.locator('#screen')).toContainText('fake-pi ready', { timeout: 15_000 })
  const resizes = (await sentFrames(page)).filter(x => x[0] === '1')
  expect(resizes).toHaveLength(0)

  await page.locator('#screen textarea').pressSequentially('again')
  await expect(page.locator('#screen')).toContainText('> markeragain')
})

test('after a server restart the page reopens its conversation on its own', async ({ page, server }) => {
  await ready(page)
  const place = () => page.evaluate(() => JSON.parse(localStorage.getItem('afield-place')))
  const before = await place()

  await server.restart()

  // Back under a new process ID, the one End and the tabs will now use.
  await expect.poll(async () => (await place()).processId, { timeout: 15_000 }).not.toBe(before.processId)
  expect((await place()).id).toBe(before.id)
  await expect(page.locator('#menu')).toBeHidden()
  await page.locator('#screen textarea').pressSequentially('after')
  await expect(page.locator('#screen')).toContainText('> after')
})

test('a current build does not reload, and a newer one is fetched past the cache', async ({ page }) => {
  await ready(page)
  expect(await page.evaluate(() => document.querySelector('meta[name=build]').content)).toMatch(/^[\w-]{12}$/)

  // Same build served: it must sit still, or a stale cache becomes a loop.
  await page.evaluate(() => window.afield.checkForNewBuild())
  await page.waitForTimeout(500)
  expect(new URL(page.url()).search).toBe('')

  // Newer build served: go to a URL the cache cannot answer from. `location.reload()`
  // is routinely handed the same stale document, which is why this is a navigation.
  await page.route(page.url(), route =>
    route.fulfill({ contentType: 'text/html', body: '<meta name="build" content="zzz9">' }))
  await Promise.all([
    page.waitForURL(/\?b=zzz9$/),
    page.evaluate(() => window.afield.checkForNewBuild()),
  ])
})
test('the menu can reload the app, since standalone has no browser chrome', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()

  const navigated = page.waitForNavigation()
  await page.getByRole('button', { name: 'Reload app' }).tap()
  await navigated

  await expect(page.locator('#screen')).toContainText('fake-pi ready')
})

test('a startup failure is reported on screen, not swallowed', async ({ page }) => {
  await ready(page)
  await expect(page.locator('#diag-overlay')).toBeHidden()

  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'boom', lineno: 42, colno: 7 })))
  await expect(page.locator('#diag-overlay')).toBeVisible()
  await expect(page.locator('#diag-overlay')).toContainText('ERROR — boom')
  await expect(page.locator('#diag-overlay')).toContainText('insets')
})

test('Reconnect before the socket exists does not fault', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: 'Reconnect' }).tap()
  await expect(page.locator('#screen')).toContainText('fake-pi ready')
  await expect(page.locator('#diag-overlay')).toBeHidden()
})

test('losing the connection is visible without opening anything', async ({ page }) => {
  await ready(page)
  await expect(page.locator('#conn')).toBeHidden()

  // A frozen terminal otherwise looks exactly like a busy one.
  await page.evaluate(() => window.afield.conn.ws.close())
  await expect(page.locator('#conn')).toBeVisible()
  expect(await page.locator('#conn').getAttribute('aria-label')).toMatch(/disconnected|connecting/)

  await expect(page.locator('#conn')).toBeHidden({ timeout: 10_000 })
})

test('reloading keeps the history above the screen, not just the screen', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)
  const before = await scrollbackCount(page)
  expect(before).toBeGreaterThan(10)

  // A reload is a fresh terminal with nothing in it, so whatever comes back has
  // to arrive in the snapshot. pi cannot page itself; this is the only history.
  await page.reload()
  await ready(page)
  await expect.poll(() => scrollbackCount(page)).toBeGreaterThan(10)
})

test('thousands of lines of history survive a reload', async ({ page }) => {
  await ready(page)
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines 3000')
  await ta.press('Enter')
  await expect.poll(() => scrollbackCount(page)).toBeGreaterThan(2900)

  await page.reload()
  await ready(page)
  await expect.poll(() => scrollbackCount(page)).toBeGreaterThan(2900)
})
