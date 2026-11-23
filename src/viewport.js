// The adapter seam. `readViewport` is the only part that touches the browser;
// everything downstream is pure and testable against on-device fixtures.

export const KEY_BAR_H = 44

// Keys sitting on the bottom edge of the glass are awkward to hit, and the outer
// two run into the display's corner curve. Lift them clear of both.
const BOTTOM_CLEARANCE = 10

const MIN_COLS = 20
const MIN_ROWS = 4

// Below this, a shrinking viewport is browser chrome, not a keyboard.
const KEYBOARD_MIN = 100

// `env(safe-area-inset-*)` cannot be read back through a custom property — it
// stays an unresolved token. Reading it as real padding on a probe element does
// resolve it.
export function readInsets() {
  const s = getComputedStyle(document.getElementById('safe-probe'))
  return {
    insetTop: parseFloat(s.paddingTop),
    insetBottom: parseFloat(s.paddingBottom),
    insetLeft: parseFloat(s.paddingLeft),
    insetRight: parseFloat(s.paddingRight),
  }
}

// The last settled keyboard-down `innerHeight` and bottom inset at each window
// width. With the keyboard up Chrome on Android reports neither faithfully, so
// a reading taken then takes its grid and lift from this. By width, not
// orientation: Chrome turns the width at once even when it keeps the old
// height. Kept for the tab's life, because a reload with the keyboard up has no
// other source.
const KEYBOARD_DOWN = 'afield-keyboard-down'
const keyboardDown = () => JSON.parse(sessionStorage.getItem(KEYBOARD_DOWN) ?? '{}')

export function readViewport() {
  const vv = window.visualViewport
  return {
    ...readInsets(),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    screenWidth: window.screen.width,
    visualWidth: vv.width,
    visualHeight: vv.height,
    offsetTop: vv.offsetTop,
    standalone: window.navigator.standalone === true,
    down: keyboardDown()[window.innerWidth] ?? null,
  }
}

/**
 * Keep the viewport's reading as its width's keyboard-down layout, if it was
 * taken with the keyboard down. Only once the viewport has settled: mid-turn
 * Chrome passes through readings that mix the two orientations. Never from a
 * panned page: iOS pans to show a focused field over the keyboard and shrinks
 * `innerHeight` by the pan, which closes the gap the keyboard is measured by.
 */
export function rememberKeyboardDown() {
  const s = readViewport()
  const l = deriveLayout(s)
  if (!l || l.keyboardUp || s.offsetTop > 0) return
  const all = keyboardDown()
  all[s.innerWidth] = { innerHeight: s.innerHeight, insetBottom: s.insetBottom }
  sessionStorage.setItem(KEYBOARD_DOWN, JSON.stringify(all))
}

/** Cell metrics for the current font, measured rather than assumed. */
export function measureCell(fontSize) {
  const el = document.getElementById('cell-probe')
  el.style.fontSize = `${fontSize}px`
  const r = el.getBoundingClientRect()
  // Row height must be a whole pixel or rows drift out of alignment down the screen.
  return { width: r.width / 10, height: Math.round(r.height) }
}

export const validVisualHeight = height => Number.isFinite(height) && height > 0

export function horizontalLayout(s) {
  // iOS updates the layout width at once on a turn, while the visual width
  // lags by ~0.5 s, past the settle that refits the grid.
  //
  // Chrome on Android stops the page short of a side cutout yet still reports
  // the cutout as an inset. Screen width the window does not cover is already
  // outside the page, so it comes off the side insets. Chrome gives no per-edge
  // signal (screenX/screenLeft are 0, outer and avail sizes equal the screen's,
  // visualViewport.offsetLeft is 0), so the shortfall comes off both sides and
  // the insets name the cutout side: only that one is nonzero. On iOS it takes
  // nothing: an iPhone's screen.width stays at the portrait width, never wider
  // than innerWidth, and an iPad window narrower than the screen (Split View,
  // Stage Manager) has no side insets to take it from.
  const avoided = Math.max(0, s.screenWidth - s.innerWidth)
  const insetLeft = Math.max(0, s.insetLeft - avoided)
  const insetRight = Math.max(0, s.insetRight - avoided)
  return { width: s.innerWidth - insetLeft - insetRight, insetLeft, insetRight }
}

/**
 * The visual viewport is the space above the keyboard (less what is `hidden`,
 * below), so the app is sized from it and never from `innerHeight`.
 *
 * Insets are asymmetric: iOS already excludes the top inset from the layout
 * viewport in standalone mode, so honouring it again would throw away the +7
 * rows standalone buys. The bottom inset sits inside the viewport and must be
 * reserved.
 *
 * `stripHeight` is the status strip's row, when it is visible. It lives under
 * the keys inside the bar: the home-indicator band absorbs it when it fits, so
 * the bar keeps its height and the terminal keeps every row; where there is no
 * band (keyboard up, or no insets at all) the bar grows by exactly the strip.
 *
 * The keyboard is the gap between the layout and visual viewports. Once it is
 * up, `s.down`, the width's last keyboard-down reading (see readViewport),
 * sizes the grid and lifts the keys. Chrome on Android drops the bottom inset
 * while the keyboard is up, and its visual viewport then runs that far under
 * the keyboard unless the window shrank by as much (it does on some devices,
 * not on others). After a turn with the keyboard up it keeps the window height
 * the keyboard was raised at, and the viewport is out by the difference until
 * the keyboard goes. Either way the part under the keyboard is `hidden`, and
 * the key bar lifts its keys clear of it. iOS reports the same inset with the
 * keyboard up and keeps the window height, so nothing is hidden there.
 */
export function deriveLayout(s, { stripHeight = 0 } = {}) {
  // iOS standalone can report negative heights even after a resize settles.
  if (!validVisualHeight(s.visualHeight)) return null
  const down = s.down ?? s
  const hidden = Math.max(0, (down.insetBottom - s.insetBottom) - (down.innerHeight - s.innerHeight))
  const keyboardHeight = Math.max(0, Math.round(s.innerHeight - s.visualHeight - s.offsetTop))
  const keyboardUp = keyboardHeight >= KEYBOARD_MIN
  // The keyboard-down layout this reading belongs to.
  const k = keyboardUp ? down : s
  const lift = keyboardUp ? hidden : 0
  const appHeight = s.visualHeight
  const { width, insetLeft, insetRight } = horizontalLayout(s)

  // The home indicator only overlaps the app when the keyboard is down; with the
  // keyboard up it sits over the keyboard, so reserving the inset there is dead
  // space. When it is down the key bar grows to cover it, keeping its keys clear
  // of the indicator — reserving it below the bar instead just leaves a gap.
  const bottomReserve = k.insetBottom + BOTTOM_CLEARANCE
  const bottomInset = keyboardUp ? 0 : bottomReserve
  const keyBarHeight = Math.max(KEY_BAR_H + bottomInset, KEY_BAR_H + stripHeight) + lift
  const keyBarPadBottom = Math.max(0, bottomInset - stripHeight) + lift

  return {
    keyboardHeight,
    keyboardUp,
    orientation: s.innerWidth > k.innerHeight ? 'landscape' : 'portrait',
    insetLeft,
    insetRight,
    appHeight,
    keyBarHeight,
    keyBarPadBottom,
    // What to size the *grid* from. The keyboard-down layout viewport, so the
    // grid stays put when the keyboard opens and the visible window just shows
    // less of it — occlude and pan, rather than reflowing pi mid-sentence.
    stableHeight: k.innerHeight - bottomReserve - KEY_BAR_H,
    terminal: {
      width,
      height: appHeight - keyBarHeight,
    },
  }
}

export const gridFor = (width, height, cell) => ({
  cols: Math.max(MIN_COLS, Math.floor(width / cell.width)),
  rows: Math.max(MIN_ROWS, Math.floor(height / cell.height)),
})
