// What the layout fuzzer needs to know about Simulator Safari.
import { execSync } from 'node:child_process'

const UDID = process.env.AFIELD_SIM_UDID ?? 'E9AABE3B-1541-49AF-83F4-7921C902F5E8'

const sleep = ms => new Promise(r => setTimeout(r, ms))

export function connect(remote, url) {
  execSync(`xcrun simctl openurl ${UDID} '${url}'`)
  return remote({
    hostname: '127.0.0.1', port: 4723, logLevel: 'error',
    capabilities: {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:udid': UDID,
      'appium:bundleId': 'com.apple.mobilesafari',
      'appium:noReset': true,
    },
  })
}

/**
 * The context of the tab in front, which is the one under test. Every openurl
 * leaves another tab behind, and a hidden one is still a viewer: the server
 * sizes the grid for the smallest, so the rest are sent away.
 */
export async function findWeb(b, url) {
  const tabState = () => b.execute(() => window.afield?.term?.bridge ? document.visibilityState : null).catch(() => null)
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    let web
    for (const { id, url: at } of await b.execute('mobile: getContexts')) {
      if (at !== url) continue
      await b.switchContext(id)
      const state = await tabState()
      if (state === 'visible') web = id
      else if (state) await b.execute(() => window.location.replace('about:blank'))
    }
    if (web) return web
  }
  throw new Error('no WEBVIEW context for the app page')
}

/**
 * Where the visible area's top left is on the glass, in points, and how many
 * points a CSS pixel is. Called in the native context with a page sample;
 * Safari's chrome moves, so the app's keyboard key is found on both sides.
 */
export async function visibleArea(b, s) {
  const [key] = await b.$$('-ios class chain:**/XCUIElementTypeButton[`name == "keyboard"`]')
  const rect = await b.getElementRect(key.elementId)
  return { top: rect.y - (s.key.top - s.visual.offsetTop), left: rect.x - s.key.left, scale: 1 }
}
