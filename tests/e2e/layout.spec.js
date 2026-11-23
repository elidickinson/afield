// Geometry: grid sizing, insets, zoom, rotation, and the keyboard.
import { test, expect, liveRows, ready, settled, fillScrollback, distanceFromBottom, fakeViewport } from './helpers.js'

test('a grid preset resizes the PTY and the client together', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '120×40' }).tap()
  await expect(page.locator('#screen')).toContainText('120x40')
  expect(await liveRows(page).count()).toBe(40)
})

test('a grid wider than the screen pans horizontally rather than reflowing', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '160×50' }).tap()
  await page.getByRole('button', { name: 'Done' }).tap()
  // Resizes wait for the output to go quiet, so this cannot be read at once.
  await expect.poll(() => page.evaluate(() => {
    const v = document.getElementById('viewport')
    return v.scrollWidth - v.clientWidth
  })).toBeGreaterThan(0)
})

test('zoom changes font size and refits the PTY grid in both directions', async ({ page }) => {
  await ready(page)
  const metrics = () => page.evaluate(() => {
    const { state } = window.afield
    const screen = document.getElementById('screen')
    return {
      cols: state.cols, rows: state.rows, font: parseFloat(getComputedStyle(screen).fontSize),
      row: screen.querySelector('.term-row').getBoundingClientRect().height,
      cellHeight: state.cell.height, coreRowHeight: window.afield.term._rowHeight,
      transform: screen.style.transform,
    }
  })
  const before = await metrics()
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.locator('[data-act="zoom-in"]').tap()
  await expect(page.locator('#scale-val')).toHaveText('125%')
  await expect.poll(() => page.evaluate(() => window.afield.state.cols)).toBeLessThan(before.cols)
  const larger = await metrics()
  expect(larger.rows).toBeLessThan(before.rows)
  expect(larger.font).toBeGreaterThan(before.font)
  expect(larger.row).toBe(larger.cellHeight)
  expect(larger.coreRowHeight).toBe(larger.row)
  expect(larger.transform).toBe('')
  await expect(page.locator('#screen')).toContainText(`${larger.cols}x${larger.rows}`)

  await page.getByRole('button', { name: '100%' }).tap()
  await expect.poll(() => page.evaluate(() => window.afield.state.cols)).toBe(before.cols)
  await page.getByRole('button', { name: '−' }).tap()
  await expect(page.locator('#scale-val')).toHaveText('80%')
  await expect.poll(() => page.evaluate(() => window.afield.state.cols)).toBeGreaterThan(before.cols)
  const smaller = await metrics()
  expect(smaller.rows).toBeGreaterThan(before.rows)
  expect(smaller.font).toBeLessThan(before.font)
  expect(smaller.row).toBe(smaller.cellHeight)
  expect(smaller.coreRowHeight).toBe(smaller.row)
  await expect(page.locator('#screen')).toContainText(`${smaller.cols}x${smaller.rows}`)
})

test('zoom keeps a parked reader near their place in scrollback', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)
  await page.evaluate(() => {
    const s = document.getElementById('screen')
    s.scrollTop = (s.scrollHeight - s.clientHeight) * 0.4
  })
  const share = () => page.evaluate(() => {
    const s = document.getElementById('screen')
    return (s.scrollHeight - s.scrollTop - s.clientHeight) / s.scrollHeight
  })
  const before = await share()
  const cols = await page.evaluate(() => window.afield.state.cols)
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.locator('[data-act="zoom-in"]').tap()
  await expect.poll(() => page.evaluate(() => window.afield.state.cols)).toBeLessThan(cols)
  await expect.poll(async () => Math.abs(await share() - before)).toBeLessThan(0.05)
  expect(await distanceFromBottom(page)).toBeGreaterThan(100)
})

test('the page itself never scrolls — only the terminal does', async ({ page }) => {
  await ready(page)
  const m = await page.evaluate(() => ({
    body: document.body.scrollHeight - window.innerHeight,
    overflow: getComputedStyle(document.body).overflow,
  }))
  expect(m.overflow).toBe('hidden')
  expect(m.body).toBeLessThanOrEqual(0)
})

test('a shorter viewport keeps the bottom of the screen in view', async ({ page }) => {
  await ready(page)
  await fillScrollback(page)
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)

  // The keyboard opening, as iOS standalone measures it: innerHeight stays 812
  // and the visual viewport loses 314pt. The grid does not reflow, so the
  // bottom rows are what must survive.
  await fakeViewport(page, 'visualViewport.resize', { visual: [402, 498] })
  await settled(page)

  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(8)
  const visible = await page.evaluate(() => {
    const s = document.getElementById('screen')
    const rows = [...s.querySelectorAll('.term-row:not(.term-scrollback-row)')].filter(r => r.innerText.trim())
    const last = rows.at(-1).getBoundingClientRect()
    const box = s.getBoundingClientRect()
    return last.bottom <= box.bottom + 2 && last.bottom > box.top
  })
  expect(visible).toBe(true)
})

test('rotating to landscape refits the grid — that is the whole point of landscape', async ({ page }) => {
  await ready(page)
  const [portraitCols] = await page.evaluate(() => [window.afield.state.cols, window.afield.state.rows])

  await page.setViewportSize({ width: 874, height: 402 })
  await expect.poll(() => page.evaluate(() => window.afield.state.cols)).toBeGreaterThan(portraitCols * 1.8)

  const [cols, rows] = await page.evaluate(() => [window.afield.state.cols, window.afield.state.rows])
  await expect(page.locator('#screen')).toContainText(`${cols}x${rows}`)

  await page.setViewportSize({ width: 402, height: 812 })
  await expect.poll(() => page.evaluate(() => window.afield.state.cols)).toBe(portraitCols)
})

test('rotating with the keyboard up fits the grid to the new width', async ({ page }) => {
  const cols = () => page.evaluate(() => window.afield.state.wanted.cols)
  await ready(page)
  const cellWidth = await page.evaluate(() => window.afield.state.cell.width)
  await fakeViewport(page, 'visualViewport.resize', { inner: [402, 714], visual: [402, 408] })
  // Past the settle, as on the phone: the keyboard was up well before the turn.
  await page.waitForTimeout(300)
  await expect.poll(cols).toBe(Math.floor(402 / cellWidth))

  // Recorded in a Safari tab on an iPhone 17 Pro: the visual viewport keeps its
  // portrait width for most of half a second after the window has turned.
  await fakeViewport(page, 'orientationchange')
  await page.waitForTimeout(27)
  await fakeViewport(page, 'resize', { inner: [874, 338], insets: { left: 62, right: 62, bottom: 20 } })
  await page.waitForTimeout(434)
  await fakeViewport(page, 'visualViewport.resize', { visual: [874, 82] })

  // 874 less 62 a side.
  await expect.poll(cols).toBe(Math.floor(750 / cellWidth))
})

// Chrome on Android after a reload: the page is short and the viewport still
// moving through the startup's fits. Here it keeps moving until the test calls
// comeToRest(), so the startup's settle is still to come until then.
const movingAtStartup = page => page.addInitScript(() => {
  const real = Object.getOwnPropertyDescriptor(window, 'innerHeight').get
  let short = 100
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => real.call(window) - short })
  const moving = setInterval(() => visualViewport.dispatchEvent(new Event('resize')), 50)
  window.comeToRest = () => {
    clearInterval(moving)
    short = 0
    visualViewport.dispatchEvent(new Event('resize'))
  }
})

test('a viewport still moving at startup is refitted once it comes to rest', async ({ page }) => {
  await ready(page)
  const rows = await page.evaluate(() => window.afield.state.wanted.rows)
  await movingAtStartup(page)
  await ready(page)
  await page.evaluate(() => window.comeToRest())
  await expect.poll(() => page.evaluate(() => window.afield.state.wanted.rows)).toBe(rows)
})

test('a preset picked before the startup settle outlasts it', async ({ page }) => {
  await page.clock.install()
  await movingAtStartup(page)
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '120×40' }).tap()
  await page.evaluate(() => window.comeToRest())
  // Past the settle, and past any resize it held back for quiet output.
  await page.clock.runFor(1000)
  expect(await page.evaluate(() => window.afield.state.wanted)).toEqual({ cols: 120, rows: 40 })
  await expect(page.locator('#screen')).toContainText('120x40')
})

// Chrome on Android can come to rest a row short after a reload and reach full
// height later, at the same width. The settle refits on the height change, not
// just on a turn, so the short grid does not stay forever.
const shortAtStartup = page => page.addInitScript(() => {
  const real = Object.getOwnPropertyDescriptor(window, 'innerHeight').get
  let short = 16
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => real.call(window) - short })
  window.growToFull = () => { short = 0; visualViewport.dispatchEvent(new Event('resize')) }
})

test('a startup that settles a row short refits when the viewport grows at the same width', async ({ page }) => {
  await page.clock.install()
  await shortAtStartup(page)
  await ready(page)
  await page.clock.runFor(250)   // the startup settle fits the short height
  const short = await page.evaluate(() => ({ cols: window.afield.state.wanted.cols, rows: window.afield.state.wanted.rows }))
  await page.evaluate(() => window.growToFull())
  await page.clock.runFor(250)   // the settle refits the grown height
  const full = await page.evaluate(() => ({ cols: window.afield.state.wanted.cols, rows: window.afield.state.wanted.rows }))
  expect(full.cols).toBe(short.cols)        // same width: a turn is not what refits
  expect(full.rows).toBeGreaterThan(short.rows)
  await expect(page.locator('#screen')).toContainText(`${full.cols}x${full.rows}`)
})

test('a reload with the keyboard up keeps the keyboard-down grid', async ({ page }) => {
  await ready(page)
  // A bottom inset with the keyboard down, as DC-1 reports: the settle stores
  // the width's keyboard-down height and inset for a reload to measure against.
  await fakeViewport(page, 'resize', { inner: [402, 812], visual: [402, 812], insets: { bottom: 24 } })
  await page.waitForTimeout(300)
  const downRows = await page.evaluate(() => window.afield.state.wanted.rows)
  // Reload with the keyboard up: Chrome keeps innerHeight, drops the inset and
  // shrinks the visual viewport. The pin makes the startup see that at once, so
  // the persisted keyboard-down sample sizes the grid rather than the reading.
  await page.addInitScript(() => {
    const pin = (o, k, g) => Object.defineProperty(o, k, { configurable: true, get: g })
    pin(VisualViewport.prototype, 'width', () => 402)
    pin(VisualViewport.prototype, 'height', () => 498)
  })
  await page.reload()
  await ready(page)
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => window.afield.state.wanted.rows)).toBe(downRows)
})

// A desktop window made shorter: innerHeight and the visual viewport shrink
// together, so there is no keyboard, and neither width nor orientation changes.
test('a window shortened at the same width refits the grid and keeps the key bar clearance, after a reload too', async ({ page }) => {
  const fit = () => page.evaluate(() => {
    const { state } = window.afield
    return {
      height: document.getElementById('app').offsetHeight,
      pad: document.getElementById('bar').style.paddingBottom,
      fits: state.wanted.rows * state.cell.height <= document.getElementById('viewport').clientHeight,
    }
  })
  await page.clock.install()
  await page.setViewportSize({ width: 500, height: 850 })
  await ready(page)
  await page.clock.runFor(250)   // the startup settle
  // The app follows when the resize event arrives, after this returns, so `fit`
  // checks its height too.
  await page.setViewportSize({ width: 500, height: 650 })
  await expect.poll(fit).toEqual({ height: 650, pad: '10px', fits: true })
  await page.reload()
  await ready(page)
  await expect.poll(fit).toEqual({ height: 650, pad: '10px', fits: true })
})

test('in Android landscape the app spans the width Chrome kept clear of the cutout', async ({ page }) => {
  const cols = () => page.evaluate(() => window.afield.state.wanted.cols)
  await ready(page)
  const cellWidth = await page.evaluate(() => window.afield.state.cell.width)
  // Recorded on a Pixel 9: Chrome stops the page short of the camera cutout,
  // 869 of the screen's 924 px, and still reports the cutout as an inset.
  await fakeViewport(page, 'orientationchange',
    { inner: [869, 303], visual: [869, 303], screenWidth: 924, insets: { right: 55, bottom: 24 } })
  await page.setViewportSize({ width: 869, height: 303 })

  await expect.poll(cols).toBe(Math.floor(869 / cellWidth))
  await expect.poll(async () => (await page.locator('#bar').boundingBox()).width).toBe(869)
})

test('the grid is sized from the layout viewport, so it outlives the keyboard', async ({ page }) => {
  await ready(page)
  const rows = await page.evaluate(() => window.afield.state.rows)
  // The scroller ends at the last written row, so the grid only outsizes the
  // window where a transcript has actually filled it.
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/stream 40')
  await ta.press('Enter')
  await expect(page.locator('#screen')).toContainText('stream line 39', { timeout: 10_000 })
  // The keyboard as iOS standalone measures it: innerHeight stays, the visual
  // viewport shrinks.
  await fakeViewport(page, 'visualViewport.resize', { visual: [402, 498] })
  await page.waitForTimeout(600)

  // More grid than fits: the rest is reachable by scrolling, not by reflowing.
  const m = await page.evaluate(() => {
    const s = document.getElementById('screen')
    return { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight }
  })
  expect(m.scrollHeight).toBeGreaterThan(m.clientHeight)
  expect(await page.evaluate(() => window.afield.state.rows)).toBe(rows)
})

test('an invalid visual height leaves layout alone until a valid resize', async ({ page }) => {
  await page.clock.install()
  await ready(page)
  const layout = () => page.evaluate(() => ({
    grid: window.afield.state.wanted,
    app: document.getElementById('app').offsetHeight,
    bar: document.getElementById('bar').offsetHeight,
  }))
  await page.clock.runFor(250)
  const before = await layout()

  await fakeViewport(page, 'visualViewport.resize', { visual: [402, -33554432] })
  await page.clock.runFor(250)
  expect(await layout()).toEqual(before)

  await page.getByRole('button', { name: 'menu' }).tap()
  await page.locator('[data-act="diag"]').tap()
  await expect(page.locator('#diag')).toContainText('visual 402x-33554432')
  await expect(page.locator('#diag')).toContainText('keyboard unknown')

  await fakeViewport(page, 'visualViewport.resize', { visual: [402, 498] })
  expect((await layout()).app).toBe(498)
})

test('when the app starts with an invalid visual height, the first valid settle fits the grid', async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => Object.defineProperty(VisualViewport.prototype, 'height', { configurable: true, get: () => -62 }))
  await ready(page)
  const grid = () => page.evaluate(() => window.afield.state.wanted)
  const before = await grid()

  await fakeViewport(page, 'visualViewport.resize', { visual: [402, 812] })
  await page.clock.runFor(250)
  expect(await grid()).not.toEqual(before)
  await expect(page.locator('#app')).toHaveCSS('height', '812px')
})

test('a page left panned for the keyboard does not refit the grid', async ({ page }) => {
  await ready(page)
  const rows = await page.evaluate(() => window.afield.state.rows)
  // As an iPhone home-screen app measured it after the screen had been off: no
  // keyboard, the page still panned by its height, innerHeight short by the pan.
  await page.evaluate(() => Object.defineProperty(VisualViewport.prototype, 'offsetTop', { configurable: true, get: () => 369 }))
  await fakeViewport(page, 'visualViewport.resize', { inner: [402, 443], visual: [402, 443] })
  await page.waitForTimeout(600)
  expect(await page.evaluate(() => window.afield.state.rows)).toBe(rows)
})

const gridRows = page => page.evaluate(() => {
  const s = document.getElementById('screen')
  const rows = [...s.querySelectorAll('.term-row:not(.term-scrollback-row)')]
  const shown = rows.filter(r => !r.hidden)
  return {
    total: rows.length,
    shown: shown.length,
    lastBottom: shown.at(-1).getBoundingClientRect().bottom,
    lastTop: shown.at(-1).getBoundingClientRect().top,
    boxTop: s.getBoundingClientRect().top,
    boxBottom: s.getBoundingClientRect().bottom,
  }
})

// A fresh fixture is the short screen: a one-line transcript, the input box
// inline after it, and an empty foot of the grid below.
test('a screen shorter than the grid ends at the key bar, not above a blank tail', async ({ page }) => {
  await ready(page)
  await settled(page)

  const m = await gridRows(page)
  expect(m.shown).toBeLessThan(m.total)
  expect(m.lastBottom).toBeCloseTo(m.boxBottom, 0)
})

test('a shorter viewport cannot strand a short screen above the fold', async ({ page }) => {
  await ready(page)
  await settled(page)

  await page.setViewportSize({ width: 402, height: 498 })   // the keyboard, near enough
  await settled(page)

  const m = await gridRows(page)
  expect(m.lastTop).toBeGreaterThanOrEqual(m.boxTop - 1)
  expect(m.lastBottom).toBeCloseTo(m.boxBottom, 0)
})

test('the key bar covers the home-indicator inset, leaving no gap beneath it', async ({ page }) => {
  await ready(page)
  await page.addStyleTag({ content: '#safe-probe { padding-bottom: 34px !important; }' })
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')))
  await page.waitForTimeout(400)

  const m = await page.evaluate(() => {
    const bar = document.getElementById('bar').getBoundingClientRect()
    const app = document.getElementById('app').getBoundingClientRect()
    const btn = document.querySelector('#bar button').getBoundingClientRect()
    return { barBottom: bar.bottom, appBottom: app.bottom, barHeight: bar.height,
             btnBottom: btn.bottom, btnHeight: btn.height }
  })
  expect(m.barBottom).toBeCloseTo(m.appBottom, 0)             // nothing wasted below it
  expect(m.barHeight).toBeCloseTo(44 + 34 + 10, 0)            // it grew by the inset and the clearance
  expect(m.btnBottom).toBeLessThanOrEqual(m.appBottom - 43)   // keys clear the indicator and the corner
  expect(m.btnHeight).toBeGreaterThan(20)
})
test('the document is not scrollable and the terminal claims vertical drags', async ({ page }) => {
  await ready(page)
  const m = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement)
    const b = getComputedStyle(document.body)
    return {
      htmlPos: s.position, bodyPos: b.position,
      htmlOverflow: s.overflow, bodyOverflow: b.overflow,
      screenTouch: getComputedStyle(document.getElementById('screen')).touchAction,
      pageTouch: [s.touchAction, b.touchAction],
      viewportTouch: getComputedStyle(document.getElementById('viewport')).touchAction,
      docScrollable: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight,
    }
  })
  expect(m.screenTouch).toBe('pan-y')
  // With the keyboard up iOS pans the whole page from any drag no scroller
  // claims, overflow or not. Desktop WebKit cannot pan, so this checks what
  // stops it: the page takes no touch gesture, and each scroller only its own.
  expect(m.pageTouch).toEqual(['none', 'none'])
  expect(m.viewportTouch).toBe('pan-x')
  expect(m.docScrollable).toBeLessThanOrEqual(0)
})

test('Fit refits rather than throwing the click event at the layout', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'menu' }).tap()
  await page.getByRole('button', { name: '50×30' }).tap()
  await expect.poll(() => page.evaluate(() => window.afield.state.rows)).toBe(30)

  await page.getByRole('button', { name: 'Fit' }).tap()
  // A listener receives the event as its first argument; passing fitGrid
  // directly made that the layout and threw on l.terminal.
  await expect(page.locator('#diag-overlay')).toBeHidden()
  await expect.poll(() => page.evaluate(() => window.afield.state.rows)).toBeGreaterThan(30)
})
