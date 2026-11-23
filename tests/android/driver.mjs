// What the layout fuzzer needs to know about Chrome on Android.

const UDID = process.env.AFIELD_ANDROID_UDID ?? 'emulator-5554'

export function connect(remote) {
  return remote({
    hostname: '127.0.0.1', port: 4723, logLevel: 'error',
    capabilities: {
      platformName: 'Android',
      browserName: 'Chrome',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': UDID,
      'appium:noReset': true,
      // Attach to Chrome as it is. Left to launch it, chromedriver first
      // clears its data: tabs, logins and all.
      'appium:chromeOptions': { androidUseRunningApp: true },
      // webdriverio's BiDi navigation is not implemented by this driver.
      'wdio:enforceWebDriverClassic': true,
    },
  })
}

/**
 * The tab in front if it is on the page, or a new one: other tabs are not ours
 * to navigate. A hidden tab on the page is still a viewer, and the server
 * sizes the grid for the smallest, so those are closed.
 */
export async function findWeb(b, url) {
  await b.switchContext('CHROMIUM')
  let front
  for (const tab of await b.getWindowHandles()) {
    await b.switchToWindow(tab)
    if (!(await b.getUrl()).startsWith(url)) continue
    if (await b.execute(() => document.visibilityState) === 'visible') front = tab
    else await b.closeWindow()
  }
  await b.switchToWindow(front ?? (await b.createWindow('tab')).handle)
  if (!front) await b.url(url)
  await b.waitUntil(() => b.execute(() => Boolean(window.afield?.term?.bridge)), { timeout: 30_000 })
  return 'CHROMIUM'
}

/**
 * Where the visible area's top left is on the glass, in device pixels, and how
 * many of them a CSS pixel is. Called in the native context with a page sample.
 * The page starts under Chrome's toolbar, whose height differs by orientation.
 * Chrome builds the page's accessibility node a moment after a load or a turn.
 */
export async function visibleArea(b, s) {
  const view = await b.$('//android.webkit.WebView')
  await view.waitForExist({ timeout: 15_000 })
  const rect = await b.getElementRect(view.elementId)
  return { top: rect.y, left: rect.x, scale: s.dpr }
}

/**
 * The top of Gboard on the glass, in device pixels: the highest of its nodes,
 * which are only in the page source with multiple windows on. Called in the
 * native context with the keyboard up.
 */
export async function keyboardTop(b) {
  await b.updateSettings({ enableMultiWindows: true })
  const xml = await b.getPageSource()
  const tops = [...xml.matchAll(/package="com\.google\.android\.inputmethod\.latin"[^>]* bounds="\[\d+,(\d+)\]/g)].map(m => Number(m[1]))
  if (!tops.length) throw new Error('no Gboard nodes in the page source: the keyboard is not up, or multiple windows are off')
  return Math.min(...tops)
}
