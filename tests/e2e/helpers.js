// Shared setup for the e2e specs: a session per test, page readiness, socket
// spying, and the scroll measurements that need a settled baseline.
import { test as base, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export { expect }

/**
 * One server, and so one program, per test.
 *
 * The server is the session now, so a shared one would carry typing and history
 * from every earlier test into the next. Port 0 lets the OS pick, which is what
 * keeps tests from colliding on a port still in TIME_WAIT.
 */
export const test = base.extend({
  // Off unless a spec asks for it with test.use({ signIn: true }), which has
  // the server make its key in the store and ask for it.
  signIn: [false, { option: true }],
  // The server's default unless a spec asks for another with test.use({ scrollback }).
  scrollback: [undefined, { option: true }],
  // Folders the picker should offer, named by a spec with test.use({ folders }).
  folders: [[], { option: true }],
  /**
   * One browser process per test, rather than Playwright's worker-scoped one.
   *
   * WebKit leaks a thread in the driver's UI process for every page it creates,
   * and none is reclaimed while that process lives. Past libdispatch's soft
   * limit of 80 threads it stops serving synchronous work and a navigation
   * stops committing: the page still boots and answers `evaluate`, but `goto`
   * never returns — a failure that looks like a wedged app and is not one. This
   * suite is long enough to cross it, and a per-page browser is where the leak
   * dies.
   */
  context: async ({ playwright, browserName, _combinedContextOptions }, use) => {
    const browser = await playwright[browserName].launch()
    const context = await browser.newContext(_combinedContextOptions)
    await use(context)
    await context.close()
    await browser.close()
  },
  /**
   * A session store shaped like pi's, holding history for folders made here.
   *
   * Every test gets one, empty by default. The point is as much what it keeps
   * out: without it the picker would enumerate the real ~/.pi store, so an e2e
   * run would depend on which projects the machine happens to have.
   */
  store: async ({ folders }, use) => {
    const root = await mkdtemp(join(tmpdir(), 'afield-e2e-store-'))
    const sessionDir = join(root, 'sessions')
    await mkdir(sessionDir)
    const seed = async cwd => {
      const slug = join(sessionDir, `-${cwd.replaceAll('/', '-')}-`)
      await mkdir(slug, { recursive: true })
      await writeFile(join(slug, 'a.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: randomUUID(), cwd })}\n`)
    }
    // There is no "start fresh in whatever folder has no history yet" any
    // more — a viewer only ever joins a session /places already lists — so
    // every test needs somewhere to land by default, seeded first (oldest)
    // so a spec that also asks for `folders` still lands on the newest of
    // those. Each seed gets its own mtime, in the order seeded: the folder
    // session (cwd) oldest, then the named folders, so the last folder named
    // in `folders` is what a fresh viewer lands on. Times are relative to
    // now — a fixed future stamp would silently invert the order on a clock
    // that reads before it — and a second apart, which no mtime resolution
    // question can collapse.
    const now = Date.now()
    await seed(process.cwd())
    const hereFile = join(sessionDir, `-${process.cwd().replaceAll('/', '-')}-`, 'a.jsonl')
    await utimes(hereFile, new Date(now - 60_000), new Date(now - 60_000))
    for (const [i, name] of folders.entries()) {
      const cwd = join(root, name)
      await mkdir(cwd)
      await seed(cwd)
      const t = now - (folders.length - i) * 1000
      await utimes(join(sessionDir, `-${cwd.replaceAll('/', '-')}-`, 'a.jsonl'),
        new Date(t), new Date(t))
    }
    await use({ root, sessionDir, at: name => join(root, name) })
    await rm(root, { recursive: true, force: true })
  },
  /**
   * The test's server. `restart()` stops it the way Ctrl-C would and starts
   * another on the same port, as a phone sees a restart.
   */
  server: async ({ signIn, scrollback, store }, use) => {
    let current = await serve({ port: 0, signIn, scrollback, store })
    await use({
      url: `http://127.0.0.1:${current.port}`,
      restart: async () => {
        const exited = new Promise(resolve => current.proc.once('exit', resolve))
        current.proc.kill('SIGINT')
        await exited
        current = await serve({ port: current.port, signIn, scrollback, store })
      },
    })
    current.proc.kill('SIGKILL')
  },
  baseURL: async ({ server }, use) => use(server.url),
})

const serve = async ({ port, signIn, scrollback, store }) => {
  const proc = spawn('node',
    ['server/cli.js', '--port', String(port), ...(signIn ? [] : ['--no-sign-in']), ...(scrollback ? ['--scrollback', String(scrollback)] : []), '--', 'tests/fixtures/fake-pi.js'],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: {
        ...process.env,
        PI_CODING_AGENT_SESSION_DIR: store.sessionDir,
        // What a terminal session runs, rather than the shell running the tests.
        SHELL: join(process.cwd(), 'tests/fixtures/fake-shell.sh'),
        XDG_CONFIG_HOME: store.root,
      },
    })
  const listening = await new Promise((resolve, reject) => {
    proc.stdout.on('data', d => {
      const found = String(d).match(/:(\d+)/)
      if (found) resolve(Number(found[1]))
    })
    proc.on('exit', code => reject(new Error(`server exited (${code}) before listening`)))
  })
  return { proc, port: listening }
}

export const screenText = page => page.locator('#screen').innerText()

/** Rows of the live grid, excluding the scrollback rendered above it. */
export const liveRows = page => page.locator('#screen .term-row:not(.term-scrollback-row)')

/** Record every frame the client puts on the wire, decoded. */
export const spySocket = page => page.evaluate(() => {
  window.__sent = []
  const send = WebSocket.prototype.send
  WebSocket.prototype.send = function (d) { window.__sent.push(new TextDecoder().decode(d)); return send.call(this, d) }
})
export const sentFrames = page => page.evaluate(() => window.__sent)
export const ready = async page => {
  await page.goto('/')
  await expect(page.locator('#screen .term-row').first()).toBeVisible()
  await expect(page.locator('#screen')).toContainText('fake-pi ready')
  await expect.poll(() => page.evaluate(() => Boolean(window.afield?.term?.bridge))).toBe(true)
  // The server decides the grid, so the client is not settled until it has said
  // so. Alone in a test, what we asked for is always what we get.
  await expect.poll(() => page.evaluate(() =>
    window.afield.state.cols === window.afield.state.wanted.cols &&
    window.afield.state.rows === window.afield.state.wanted.rows)).toBe(true)
}

/**
 * Replay what an iPhone reported about its viewport, in desktop WebKit.
 *
 * Desktop WebKit has no keyboard, no safe-area insets and no gap between the
 * layout and visual viewports, so the values iOS reported are pinned onto the
 * live objects with getters and the event iOS fired is dispatched by hand. Only
 * the readings are faked: CSS still lays out against the real window.
 *
 * `event` is the one iOS fired: 'orientationchange', 'resize' (the window's) or
 * 'visualViewport.resize'. Each call changes only the values it names and the
 * rest keep their last value, so a recorded timeline reads as its diffs:
 *
 *   inner: [w, h]    window.innerWidth / innerHeight
 *   screenWidth: w   screen.width; starts at the first inner width, the
 *                    portrait width iOS keeps reporting through a turn
 *   visual: [w, h]   visualViewport.width / height
 *   insets: { top, right, bottom, left }   safe-area insets, missing sides 0
 */
export const fakeViewport = (page, event, values = {}) => page.evaluate(([event, v]) => {
  window.__fakeViewport ??= (() => {
    const fake = {
      inner: [innerWidth, innerHeight],
      screenWidth: innerWidth,
      visual: [visualViewport.width, visualViewport.height],
      style: document.head.appendChild(document.createElement('style')),
    }
    const pin = (obj, key, get) => Object.defineProperty(obj, key, { configurable: true, get })
    pin(window, 'innerWidth', () => fake.inner[0])
    pin(window, 'innerHeight', () => fake.inner[1])
    pin(Screen.prototype, 'width', () => fake.screenWidth)
    // On the prototype: WebKit can collect the JS wrapper of an object nothing
    // in JS holds and hand back a fresh one without the pin.
    pin(VisualViewport.prototype, 'width', () => fake.visual[0])
    pin(VisualViewport.prototype, 'height', () => fake.visual[1])
    return fake
  })()
  const fake = window.__fakeViewport
  if (v.inner) fake.inner = v.inner
  if (v.screenWidth) fake.screenWidth = v.screenWidth
  if (v.visual) fake.visual = v.visual
  if (v.insets) {
    const { top = 0, right = 0, bottom = 0, left = 0 } = v.insets
    // The app reads insets back as the padding of #safe-probe.
    fake.style.textContent = `#safe-probe { padding: ${top}px ${right}px ${bottom}px ${left}px !important; }`
  }
  const [target, type] = event.startsWith('visualViewport.')
    ? [visualViewport, event.slice('visualViewport.'.length)]
    : [window, event]
  target.dispatchEvent(new Event(type))
}, [event, values])

export const scrollTop = page => page.evaluate(() => document.getElementById('screen').scrollTop)

export const distanceFromBottom = page => page.evaluate(() => {
  const s = document.getElementById('screen')
  return s.scrollHeight - s.scrollTop - s.clientHeight
})

// The view stays pinned to the bottom while wterm renders, so scrollTop climbs
// until the content stops growing. Every scroll assertion needs that baseline.
export const settled = async page => {
  let last = -1
  await expect.poll(async () => {
    const now = await scrollTop(page)
    const stable = now === last
    last = now
    return stable
  }, { intervals: Array(14).fill(150) }).toBe(true)
  return last
}

export const scrollbackCount = page => page.evaluate(() => window.afield.term.bridge.getScrollbackCount())

/**
 * The drawn scrollback window against the core. The renderer keys each drawn
 * row on the ring's absolute line (the discarded count included), so the
 * window should match the core at every render; `bad` counts the rows that
 * do not -- DOM and core diverged. `rows` and `core` are asserted alongside
 * `bad` because an empty DOM has nothing to disagree with, and a poll would
 * take that for a pass.
 */
export const drawnWindow = page => page.evaluate(() => {
  const b = window.afield.term.bridge
  const r = window.afield.term.renderer
  const rows = [...document.getElementById('screen').querySelectorAll('.term-scrollback-row')]
  // First drawn row's absolute index, straight from the renderer's keying:
  // startKey = discarded + start, and the discarded count it was keyed with
  // is stored beside it. DOM row j is absolute index start + j; core offsets
  // run newest-first.
  const start = r._scrollbackStartKey - r._renderedDiscardedCount
  const core = b.getScrollbackCount()
  const coreLine = off => {
    let t = ''
    for (let c = 0; c < b.getScrollbackLineLen(off); c++) t += String.fromCodePoint(b.getScrollbackCell(off, c).char)
    return t.replace(/\s+$/, '')
  }
  const bad = rows.filter((row, j) =>
    row.textContent.replace(/\s+$/, '') !== coreLine(core - 1 - (start + j))).length
  return {
    bad,
    rows: rows.length,
    core,
    start,
    first: rows[0]?.innerText.trim(),
    last: rows.at(-1)?.innerText.trim(),
    coreNewest: coreLine(0),
  }
})

/**
 * Sample the scroller and the line under a fixed eye-point, every frame.
 *
 * A reading position is two facts: where the box is (scrollTop) and which line
 * sits at the top of it. The squirm being chased can move either while no
 * finger is down, and it lasts a frame or two — so nothing that asserts after
 * the fact can see it. The trace makes it countable instead.
 *
 * `eye` is the row under a fixed point 60px into the screen: literally the line
 * the reader is looking at, independent of how scrollTop or row indices move.
 * The fixture numbers every line uniquely, so `head` is an identity — content
 * sliding under a still box shows up as an identity change even when the row
 * count, the scrollHeight and the scrollTop are all unchanged (the rebuild's
 * signature). `height` separates the other suspect: growing geometry is the
 * below-cap append path, frozen geometry with moving content is the rebuild.
 *
 * `parkAt` sets scrollTop in the same turn the sampler starts, so the first
 * sample is taken before app.js's scrollback-rebuild timer can fire.
 */
export const startScrollTrace = (page, { parkAt } = {}) => page.evaluate(fraction => {
  cancelAnimationFrame(window.__traceRaf)
  const screen = document.getElementById('screen')
  if (fraction !== undefined) {
    const max = screen.scrollHeight - screen.clientHeight
    screen.scrollTop = Math.round(max * fraction)
  }
  const rect = screen.getBoundingClientRect()
  const eyeX = rect.left + Math.min(200, rect.width / 2)
  const eyeY = rect.top + 60
  window.__trace = []
  const sample = () => {
    // A sample whose eye-point hits nothing is recorded as null, never
    // synthesized from scrollTop: mid-rebuild is exactly when the point can
    // go missing, and a synthesized identity would launder whatever moved the
    // box into a matching trace. Consumers skip nulls.
    const el = document.elementFromPoint(eyeX, eyeY)?.closest('.term-row') ?? null
    window.__trace.push({
      t: Math.round(performance.now()),
      top: Math.round(screen.scrollTop),
      height: screen.scrollHeight,
      head: el?.textContent.slice(0, 24) ?? null,
    })
    window.__traceRaf = requestAnimationFrame(sample)
  }
  window.__traceRaf = requestAnimationFrame(sample)
}, parkAt)

/** Stop sampling and hand back the trace; samples carry test-local time. */
export const stopScrollTrace = page => page.evaluate(() => {
  cancelAnimationFrame(window.__traceRaf)
  const trace = window.__trace ?? []
  window.__trace = null
  return trace
})

/** The line number in a traced head; NaN when the row is not fixture-numbered. */
export const lineNo = head => Number(/(?:scrollback|stream) line (\d+)/.exec(head)?.[1] ?? NaN)

/** Widest swing in line identity over the trace, from its first content sample. */
export const maxHeadShift = trace => {
  const base = lineNo(trace.find(s => s.head != null)?.head)
  if (Number.isNaN(base)) return NaN
  return trace.reduce((m, s) => s.head == null ? m : Math.max(m, Math.abs(lineNo(s.head) - base)), 0)
}

// Push real history above the fold. `/lines` makes the fixture scroll a fixed
// block off the top, so the depth does not depend on the grid or on how many
// keystrokes survive a busy machine.
export const fillScrollback = async page => {
  const ta = page.locator('#screen textarea')
  await ta.pressSequentially('/lines')
  await ta.press('Enter')
  await expect.poll(() => scrollbackCount(page)).toBeGreaterThan(10)
  return settled(page)
}
