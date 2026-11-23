// Fuzz the layout in Simulator Safari or the Android emulator's Chrome: random
// bursts of keyboard up/down, rotation, taps, drags and output, then a wait for
// everything to come to rest and a check that the page is where it should be.
//
//   node tests/ios/fuzz.mjs [--platform ios|android] [--seed N] [--steps N]
//
// The seed fixes the order of actions, not their timing: a native command
// takes 50-400ms to land, so a replay is close, not identical. After a failure
// the page is reloaded upright, so one stuck state is not reported at every
// step after it.
import { remote } from 'webdriverio'
import { mkdirSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { KEY_BAR_H } from '../../src/viewport.js'
import { decodePng } from './png.mjs'

const BASE_URL = process.env.AFIELD_URL ?? 'http://127.0.0.1:8199/'
const SHOTS = '/tmp/afield-fuzz'
const { values: args } = parseArgs({ options: {
  platform: { type: 'string', default: 'ios' },
  seed: { type: 'string' },
  steps: { type: 'string', default: '25' },
} })
// How a session reaches the page, and where the page sits on the glass.
const driver = await import(`../${args.platform}/driver.mjs`)
const SEED = Number(args.seed ?? Date.now() % 1_000_000)
const STEPS = Number(args.steps)

// Output has to have stopped for longer than every window the client keeps
// open behind it: its resize quiet time, the server's coalescing, the
// reading-position re-pin and the two seconds a snapshot is followed for.
const OUTPUT_REST_MS = 2600
const EVENT_REST_MS = 1000
const REST_TIMEOUT_MS = 15_000

const sleep = ms => new Promise(r => setTimeout(r, ms))

// mulberry32
let seed = SEED
const random = () => {
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = list => list[Math.floor(random() * list.length)]

// --- session --------------------------------------------------------------------

const b = await driver.connect(remote, BASE_URL)
let web   // the page's context, found once the session is up

const page = async (fn, ...rest) => { await b.switchContext(web); return b.execute(fn, ...rest) }
const native = () => b.switchContext('NATIVE_APP')

// --- page side ------------------------------------------------------------------

/** Paint what is behind the app, and note when the viewport and the stream last moved. */
const install = () => {
  // Anything magenta on the glass is the page showing where the app should be.
  const style = document.createElement('style')
  style.textContent = 'html, body { background: #f0f !important } #app { background: var(--bg) }'
  document.head.append(style)

  const f = window.__fuzz = { event: performance.now(), output: performance.now() }
  const moved = () => { f.event = performance.now() }
  for (const type of ['resize', 'scroll']) {
    visualViewport.addEventListener(type, moved)
    window.addEventListener(type, moved)
  }
  window.addEventListener('orientationchange', moved)
  const conn = window.afield.conn
  const deliver = conn.onOutput
  conn.onOutput = bytes => { f.output = performance.now(); deliver(bytes) }
}

const sample = () => {
  const rect = id => {
    const r = document.getElementById(id).getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), left: Math.round(r.left) }
  }
  const { state, term, conn } = window.afield
  const screen = document.getElementById('screen')
  const box = document.getElementById('viewport')
  const vv = window.visualViewport
  const key = document.querySelector('#keys button[name="keyboard"]').getBoundingClientRect()
  const round = n => Math.round(n * 100) / 100

  // The numbered lines the fixture printed, oldest first. wterm counts saved
  // rows from the newest.
  const lines = []
  for (let i = term.bridge.getScrollbackCount() - 1; i >= 0; i--) {
    let text = ''
    for (let x = 0; x < 20; x++) text += String.fromCodePoint(term.bridge.getScrollbackCell(i, x).char || 32)
    const found = text.match(/^scrollback line (\d+)/)
    if (found) lines.push(Number(found[1]))
  }
  const now = performance.now()
  return {
    quiet: { event: now - window.__fuzz.event, output: now - window.__fuzz.output },
    inner: [window.innerWidth, window.innerHeight],
    visual: { width: Math.round(vv.width), height: Math.round(vv.height), offsetTop: Math.round(vv.offsetTop) },
    scrollY: Math.round(window.scrollY),
    app: rect('app'),
    bar: rect('bar'),
    barPad: parseFloat(document.getElementById('bar').style.paddingBottom),
    strip: document.getElementById('strip').hidden ? 0 : state.cell.height,
    // The keyboard key: its corner, and its middle.
    key: { left: round(key.left), top: round(key.top), x: round(key.left + key.width / 2), y: round(key.top + key.height / 2) },
    keysBottom: round(key.bottom),
    dpr: window.devicePixelRatio,
    // The terminal's box, not #screen: with no room for a row the app stops
    // resizing #screen, which then keeps its last height out of sight.
    boxHeight: box.clientHeight,
    fromBottom: Math.round(screen.scrollHeight - screen.scrollTop - screen.clientHeight),
    latestHidden: document.getElementById('to-bottom').hidden,
    cell: state.cell.height,
    grid: `${state.cols}x${state.rows}`,
    wanted: `${state.wanted.cols}x${state.wanted.rows}`,
    sent: `${conn.cols}x${conn.rows}`,
    connected: conn.connected,
    lines,
  }
}

/** Sample until two in a row agree and nothing has moved for a while. */
async function rest() {
  let last = null
  for (const deadline = Date.now() + REST_TIMEOUT_MS; Date.now() < deadline;) {
    await sleep(300)
    const { quiet, ...now } = await page(sample)
    const same = JSON.stringify(now) === JSON.stringify(last)
    if (same && quiet.event > EVENT_REST_MS && quiet.output > OUTPUT_REST_MS) return now
    last = now
  }
  return null
}

// --- native side ----------------------------------------------------------------

/**
 * Where the visible area sits on the glass. `x` and `y` turn CSS pixels from
 * its top left into the units native gestures and screenshots are measured in:
 * points on iOS, device pixels on Android.
 */
async function glass() {
  const s = await page(sample)
  await native()
  const { top, left, scale } = await driver.visibleArea(b, s)
  const x = css => left + css * scale
  const y = css => top + css * scale
  return { s, scale, x, y, key: { x: x(s.key.x), y: y(s.key.y - s.visual.offsetTop) } }
}

async function tap(x, y) {
  await native()
  await b.performActions([{
    type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 60 },
      { type: 'pointerUp', button: 0 },
    ],
  }])
  await b.releaseActions()
}

async function swipe(x, y0, y1, duration) {
  await native()
  await b.performActions([{
    type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y0) },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration, x: Math.round(x), y: Math.round(y1) },
      { type: 'pointerUp', button: 0 },
    ],
  }])
  await b.releaseActions()
}

/**
 * Vertical runs of magenta at least a row tall, in CSS pixels, down three
 * columns of the visible area. Below it the keyboard is translucent and shows
 * the page through by design.
 */
async function magentaBands(png, g) {
  await native()
  const { width } = await b.getWindowRect()
  const image = decodePng(png)
  const perNative = image.width / width
  const scale = perNative * g.scale   // image pixels per CSS pixel
  const from = g.y(0) * perNative
  const to = g.y(g.s.visual.height) * perNative
  const minHeight = g.s.cell
  const bands = []
  for (const share of [0.25, 0.5, 0.75]) {
    const x = Math.round(image.width * share)
    let start = null
    const end = Math.min(image.height, Math.round(to))
    for (let y = Math.round(from); y <= end; y++) {
      const [r, g, bl] = y < end ? image.pixel(x, y) : [0, 0, 0]
      const magenta = r > 200 && g < 90 && bl > 200
      if (magenta && start === null) start = y
      if (!magenta && start !== null) {
        if ((y - start) / scale >= minHeight) bands.push(`${Math.round(start / scale)}..${Math.round(y / scale)} at x=${Math.round(x / scale)}`)
        start = null
      }
    }
  }
  return bands
}

// --- actions --------------------------------------------------------------------

// Whether the fuzzer itself scrolled the reader off the live edge.
let parked = false

const actions = {
  /** The app's own keyboard key. */
  async keyboard() {
    const g = await glass()
    await tap(g.key.x, g.key.y)
  },
  async rotate() {
    await native()
    await b.setOrientation(await b.getOrientation() === 'PORTRAIT' ? 'LANDSCAPE' : 'PORTRAIT')
  },
  /** A tap on the terminal focuses it, which raises the keyboard. */
  async tapTerminal() {
    const g = await glass()
    await tap(g.x(g.s.visual.width / 2), g.y(Math.min(100, g.s.visual.height / 3)))
  },
  /** A drag that starts on the bar's edge padding, which is not a scroller. */
  async dragBarEdge() {
    const g = await glass()
    await swipe(g.x(g.s.bar.left + 3), g.key.y, g.key.y - 200 * g.scale, 200)
  },
  /** Drag down on the terminal to read back into history. */
  async readHistory() {
    const g = await glass()
    const { width, height } = g.s.visual
    if (height < 150) return
    await swipe(g.x(width / 2), g.y(height * 0.25), g.y(height * 0.7), 300)
    parked = true
  },
  async toBottom() {
    await page(() => { const s = document.getElementById('screen'); s.scrollTop = s.scrollHeight })
    parked = false
  },
  async type() {
    await page(() => window.afield.conn.send('hello\r'))
  },
  /** A line every 100ms for a second and a half. */
  async stream() {
    await page(() => window.afield.conn.send('/stream 15\r'))
  },
}
const WEIGHTED = ['keyboard', 'keyboard', 'keyboard', 'rotate', 'rotate', 'rotate',
  'tapTerminal', 'dragBarEdge', 'readHistory', 'toBottom', 'type', 'stream']

// --- the checks -----------------------------------------------------------------

const baseline = { grid: {}, lines: null }

async function check() {
  const s = await rest()
  if (!s) return ['never came to rest']
  await native()
  const keyboardUp = await b.isKeyboardShown()
  const orientation = await b.getOrientation()
  const png = Buffer.from(await b.takeScreenshot(), 'base64')

  const wrong = []
  const expect = (ok, what) => { if (!ok) wrong.push(what) }
  const near = (a, c) => Math.abs(a - c) <= 1

  expect(s.connected, 'the socket is down')
  expect(near(s.app.top, s.visual.offsetTop) && near(s.app.height, s.visual.height),
    `the app (top ${s.app.top}, height ${s.app.height}) is not on the visible area (top ${s.visual.offsetTop}, height ${s.visual.height})`)
  // Landscape with the keyboard up can leave less height than the key bar and
  // a row (32px in a Safari tab on an iPhone 17 Pro). That much the app accepts:
  // the bar overflows the app and no row shows until the keyboard goes.
  // Judged by the bar's intended height, so a bar grown too tall is still caught.
  const cramped = keyboardUp && orientation === 'LANDSCAPE' && s.visual.height < KEY_BAR_H + s.strip + s.cell
  if (!cramped) {
    expect(near(s.bar.bottom, s.app.bottom), `the key bar ends at ${s.bar.bottom}, the app at ${s.app.bottom}`)
    expect(s.boxHeight >= s.cell, 'no terminal row is visible')
  }
  if (keyboardUp && driver.keyboardTop) {
    // Chrome on Android can run the visible area under the keyboard, and the
    // bar's padding then lifts the keys clear of it: judged on the glass. The
    // keys end on the keyboard's top edge, give or take a row, so a stale turn
    // that leaves them far above it is still caught.
    const g = await glass()
    const keys = Math.round(g.y(g.s.keysBottom - g.s.visual.offsetTop))
    const top = await driver.keyboardTop(b)
    expect(keys <= top + 1 && keys >= top - g.scale * (g.s.cell + 1),
      `the keys end at ${keys}, the keyboard starts at ${top} (device px)`)
  } else if (keyboardUp) {
    expect(s.barPad === 0, `the key bar reserves ${s.barPad}px for the home indicator while the keyboard is up`)
  } else {
    expect(s.scrollY === 0 && s.visual.offsetTop === 0,
      `the page is scrolled (scrollY ${s.scrollY}, offsetTop ${s.visual.offsetTop}) with the keyboard down`)
    expect(near(s.visual.height, s.inner[1]),
      `the visible area is ${s.visual.height} tall in a ${s.inner[1]} page with the keyboard down`)
  }

  const grid = baseline.grid[orientation]
  if (grid) expect(s.wanted === grid, `${orientation} asked for a ${s.wanted} grid, not ${grid}`)
  expect(s.sent === s.wanted && s.grid === s.wanted, `wanted ${s.wanted}, sent ${s.sent}, rendering ${s.grid}`)

  if (!parked) expect(s.fromBottom < 5, `left ${s.fromBottom}px above the live edge without being scrolled`)
  if (s.fromBottom < 5) expect(s.latestHidden, 'the "latest" button shows at the live edge')
  if (baseline.lines) {
    expect(JSON.stringify(s.lines) === JSON.stringify(baseline.lines),
      `history holds lines ${s.lines[0]}..${s.lines.at(-1)} (${s.lines.length}), not ${baseline.lines[0]}..${baseline.lines.at(-1)} (${baseline.lines.length})`)
  }

  const bands = await magentaBands(png, await glass())
  expect(bands.length === 0, `the page shows through the app: ${bands.join(', ')}`)
  return { wrong, png, state: { keyboardUp, orientation, ...s, lines: s.lines.length } }
}

/** A fresh page, upright, keyboard down, at the live edge. */
async function reset() {
  await native()
  await b.setOrientation('PORTRAIT')
  // The marker goes with the old document, so its absence means the new one.
  await page(() => { window.__stale = true; window.location.reload() })
  const fresh = () => b.execute(() => !window.__stale && Boolean(window.afield?.conn?.connected)).catch(() => false)
  for (let i = 0; i < 60 && !await fresh(); i++) await sleep(250)
  await page(() => document.activeElement?.blur())
  await page(install)
  parked = false
}

// --- run ------------------------------------------------------------------------

async function run() {
console.log(`seed ${SEED}, ${STEPS} steps`)
mkdirSync(SHOTS, { recursive: true })
web = await driver.findWeb(b, BASE_URL)
await reset()
await page(() => window.afield.conn.send('/lines 200\r'))

// What a calm page settles on is the reference for everything after.
for (const orientation of ['PORTRAIT', 'LANDSCAPE', 'PORTRAIT']) {
  await native()
  await b.setOrientation(orientation)
  const calm = await check()
  if (calm.wrong?.length) throw new Error(`not sound before fuzzing, ${orientation}: ${calm.wrong.join('; ')}`)
  baseline.grid[orientation] = calm.state.wanted
}
baseline.lines = (await page(sample)).lines
console.log(`calm: portrait ${baseline.grid.PORTRAIT}, landscape ${baseline.grid.LANDSCAPE}, ${baseline.lines.length} numbered lines of history\n`)

const failures = new Map()   // what went wrong -> { count, first }
let trail = []
for (let step = 1; step <= STEPS; step++) {
  const burst = 1 + Math.floor(random() * 3)
  for (let i = 0; i < burst; i++) {
    const name = pick(WEIGHTED)
    const gap = pick([0, 0, 60, 150, 300])
    await actions[name]()
    trail.push(gap ? `${name} +${gap}ms` : name)
    await sleep(gap)
  }
  const result = await check()
  const wrong = result.wrong ?? result
  console.log(`${String(step).padStart(3)} ${wrong.length ? 'FAIL' : 'ok  '} ${trail.slice(-burst).join(', ')}`)
  if (!wrong.length) continue

  const shot = `${SHOTS}/seed${SEED}-step${step}.png`
  if (result.png) writeFileSync(shot, result.png)
  for (const what of wrong) {
    console.log(`       ${what}`)
    // The numbers differ run to run; the sentence around them is the failure.
    const kind = what.replace(/-?\d+(\.\d+)?/g, 'N')
    const seen = failures.get(kind) ?? { count: 0, first: { step, what, trail: [...trail], shot, state: result.state } }
    seen.count++
    failures.set(kind, seen)
  }
  await reset()
  trail = []
}

await native()
await b.setOrientation('PORTRAIT')

console.log(`\n${failures.size} kinds of failure in ${STEPS} steps (seed ${SEED})`)
for (const { count, first } of failures.values()) {
  console.log(`\n- ${first.what}\n  ${count}x, first at step ${first.step} after: ${first.trail.join(' -> ')}\n  ${first.shot}`)
}
writeFileSync(`${SHOTS}/seed${SEED}.json`, JSON.stringify([...failures.values()], null, 2))
return failures.size
}

// A session left behind keeps its hold on the page, and the next run's switch
// to that page then hangs.
let failed
try { failed = await run() } finally { await b.deleteSession() }
process.exit(failed ? 1 : 0)
