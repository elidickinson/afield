// Layout maths, checked against the five configurations measured on device.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveLayout, gridFor, KEY_BAR_H } from '../../src/viewport.js'

// Production measures the cell at runtime; this is what the device reported at
// 13px, so the grid math can be checked against the recorded configurations.
const CELL_13PX = { width: 8.04, height: 15.0 }

// The five configurations measured on device (iPhone, 402x874 pt). iOS keeps
// screen.width at the portrait width in either orientation.
const FIXTURES = {
  'safari portrait, kb down': {
    innerWidth: 402, innerHeight: 714, visualWidth: 402, visualHeight: 714, offsetTop: 0, screenWidth: 402,
    insetTop: 0, insetBottom: 0, insetLeft: 0, insetRight: 0, standalone: false,
    expect: { keyboardHeight: 0, keyboardUp: false, orientation: 'portrait' },
  },
  'safari portrait, kb up': {
    innerWidth: 402, innerHeight: 714, visualWidth: 402, visualHeight: 404, offsetTop: 0, screenWidth: 402,
    insetTop: 0, insetBottom: 0, insetLeft: 0, insetRight: 0, standalone: false,
    expect: { keyboardHeight: 310, keyboardUp: true, orientation: 'portrait' },
  },
  'standalone portrait, kb down': {
    innerWidth: 402, innerHeight: 812, visualWidth: 402, visualHeight: 812, offsetTop: 0, screenWidth: 402,
    insetTop: 62, insetBottom: 34, insetLeft: 0, insetRight: 0, standalone: true,
    expect: { keyboardHeight: 0, keyboardUp: false, orientation: 'portrait' },
  },
  'standalone portrait, kb up': {
    innerWidth: 402, innerHeight: 812, visualWidth: 402, visualHeight: 498, offsetTop: 0, screenWidth: 402,
    insetTop: 62, insetBottom: 34, insetLeft: 0, insetRight: 0, standalone: true,
    expect: { keyboardHeight: 314, keyboardUp: true, orientation: 'portrait' },
  },
  'standalone landscape, kb down': {
    innerWidth: 874, innerHeight: 402, visualWidth: 874, visualHeight: 402, offsetTop: 0, screenWidth: 402,
    insetTop: 0, insetBottom: 20, insetLeft: 62, insetRight: 62, standalone: true,
    expect: { keyboardHeight: 0, keyboardUp: false, orientation: 'landscape' },
  },
}

for (const [name, f] of Object.entries(FIXTURES)) {
  test(`layout — ${name}`, () => {
    const l = deriveLayout(f)
    assert.equal(l.keyboardHeight, f.expect.keyboardHeight)
    assert.equal(l.keyboardUp, f.expect.keyboardUp)
    assert.equal(l.orientation, f.expect.orientation)

    // Everything the app draws must fit inside the visual viewport, which is
    // by definition the space above the keyboard.
    assert.ok(l.appHeight <= f.visualHeight, 'app is sized from the visual viewport, never innerHeight')
    assert.equal(l.terminal.height + l.keyBarHeight, f.visualHeight, 'no gap anywhere')
    assert.ok(l.terminal.height > 0)
  })
}

test('nonpositive and nonfinite visual heights do not describe a layout', () => {
  const f = FIXTURES['standalone portrait, kb down']
  for (const visualHeight of [-33554432, 0, NaN, Infinity]) {
    assert.equal(deriveLayout({ ...f, visualHeight }), null)
  }
})

test('the top inset is already excluded from the viewport, so subtracting it would double-count', () => {
  const standalone = deriveLayout(FIXTURES['standalone portrait, kb down'])
  const safari = deriveLayout(FIXTURES['safari portrait, kb down'])
  // Standalone reports a 62pt top inset but its viewport is already 98pt taller
  // than Safari's. Honouring the inset again would erase that win.
  assert.ok(standalone.terminal.height > safari.terminal.height)
})

test('with the keyboard down the key bar covers the bottom inset', () => {
  const l = deriveLayout(FIXTURES['standalone portrait, kb down'])
  assert.equal(l.keyBarHeight, KEY_BAR_H + 34 + 10, 'the bar grows rather than leaving a gap')
  assert.equal(l.keyBarPadBottom, 34 + 10, 'its keys stay clear of the home indicator and the corner curve')
  assert.equal(l.terminal.height, 812 - (34 + 10) - KEY_BAR_H)
})

test('with the keyboard up the bottom inset is not reserved — it is over the keyboard', () => {
  const up = deriveLayout(FIXTURES['standalone portrait, kb up'])
  assert.equal(up.keyBarHeight, KEY_BAR_H)
  assert.equal(up.keyBarPadBottom, 0)
  assert.equal(up.terminal.height, 498 - KEY_BAR_H, 'reclaims the whole bottom reserve')

  const rows = Math.floor(up.terminal.height / 15)
  const reserved = Math.floor((498 - (34 + 10) - KEY_BAR_H) / 15)
  assert.ok(rows > reserved, 'that is a whole extra row of pi')
})

test('the strip is absorbed by the home-indicator band when it fits', () => {
  const l = deriveLayout(FIXTURES['standalone portrait, kb down'], { stripHeight: 15 })
  assert.equal(l.keyBarHeight, KEY_BAR_H + 34 + 10, 'the bar does not grow — the band has room')
  assert.equal(l.keyBarPadBottom, 34 + 10 - 15, 'the pad under the keys shrinks by exactly the strip')
  assert.equal(l.terminal.height, 812 - (34 + 10) - KEY_BAR_H, 'the terminal keeps every row')
  assert.equal(l.stableHeight, 812 - (34 + 10) - KEY_BAR_H, 'and the grid is untouched')
})

test('where there is no band, the strip grows the bar by one row', () => {
  // Safari has no insets at all; with the keyboard up the band is not reserved.
  const safari = deriveLayout(FIXTURES['safari portrait, kb down'], { stripHeight: 15 })
  assert.equal(safari.keyBarHeight, KEY_BAR_H + 15)
  assert.equal(safari.keyBarPadBottom, 0)

  const kbUp = deriveLayout(FIXTURES['standalone portrait, kb up'], { stripHeight: 15 })
  assert.equal(kbUp.keyBarHeight, KEY_BAR_H + 15)
  assert.equal(kbUp.keyBarPadBottom, 0)
})

test('the grid is sized from the layout viewport, so the keyboard never reflows it', () => {
  const down = deriveLayout(FIXTURES['standalone portrait, kb down'])
  const up = deriveLayout(FIXTURES['standalone portrait, kb up'])
  assert.equal(down.stableHeight, up.stableHeight, 'same grid whether the keyboard is up or not')
  assert.equal(up.stableHeight, 812 - (34 + 10) - KEY_BAR_H)
  assert.ok(up.stableHeight > up.terminal.height, 'more grid than fits on screen — pan to the rest')
})

test('landscape is worth nearly twice the columns, after the side insets', () => {
  const portrait = deriveLayout(FIXTURES['standalone portrait, kb down'])
  const landscape = deriveLayout(FIXTURES['standalone landscape, kb down'])
  const p = gridFor(portrait.terminal.width, portrait.stableHeight, CELL_13PX)
  const l = gridFor(landscape.terminal.width, landscape.stableHeight, CELL_13PX)
  assert.equal(p.cols, 50)
  // iOS reports 62pt on *both* sides in landscape, so 874pt of glass yields 750.
  assert.equal(landscape.terminal.width, 750)
  assert.equal(l.cols, 93)
  assert.ok(l.rows < p.rows, 'it trades rows for columns')
})

test('a side cutout Chrome on Android already keeps the page clear of is not inset again', () => {
  // Pixel 9 in landscape: the window stops short of the cutout, 869 of the
  // screen's 924 px, yet Chrome still reports the cutout as a 55 px inset.
  const l = deriveLayout({
    innerWidth: 869, innerHeight: 303, visualWidth: 869, visualHeight: 303, offsetTop: 0, screenWidth: 924,
    insetTop: 0, insetBottom: 24, insetLeft: 0, insetRight: 55, standalone: false,
  })
  assert.equal(l.terminal.width, 869)
  assert.equal(l.insetRight, 0, 'and the app is not padded by it')
})

test('offsetTop counts against available height', () => {
  const f = { ...FIXTURES['safari portrait, kb up'], offsetTop: 40, visualHeight: 364 }
  assert.equal(deriveLayout(f).keyboardHeight, 310)
})

test('browser chrome collapsing is not mistaken for a keyboard', () => {
  const f = { ...FIXTURES['safari portrait, kb down'], innerHeight: 780, visualHeight: 714 }
  assert.equal(deriveLayout(f).keyboardUp, false)
})

test('grid math matches the measured device numbers', () => {
  assert.deepEqual(gridFor(402, 714, CELL_13PX), { cols: 50, rows: 47 })
  assert.deepEqual(gridFor(402, 404, CELL_13PX), { cols: 50, rows: 26 })
  assert.deepEqual(gridFor(402, 812, CELL_13PX), { cols: 50, rows: 54 })
  assert.deepEqual(gridFor(402, 498, CELL_13PX), { cols: 50, rows: 33 })
  assert.deepEqual(gridFor(750, 402, CELL_13PX), { cols: 93, rows: 26 })
})

test('grid never collapses below a usable minimum', () => {
  assert.deepEqual(gridFor(1, 1, CELL_13PX), { cols: 20, rows: 4 })
})

// --- Android, measured on device ----------------------------------------------
//
// Two devices that report the keyboard differently. DC-1 (a real tablet) keeps
// innerHeight when the keyboard rises and drops the bottom inset to 0, so the
// visual viewport runs under the keyboard by the inset and the keys must lift.
// The Pixel 9 emulator shrinks innerHeight by the inset it drops, so its visual
// viewport already stops at the keyboard and the keys need no lift. Both keep
// the keyboard-down grid: the keyboard never reflows pi.
//
// `down` is the width's last settled keyboard-down reading, as readViewport
// supplies it from sessionStorage. The cell is what each device measured.
const CELL_DC1 = { width: 7.8, height: 16 }        // 121x67 portrait, 162x47 landscape
const CELL_EM = { width: 7.798214721679687, height: 16 }
const android = (over, down) => ({
  insetTop: 0, insetLeft: 0, insetRight: 0, offsetTop: 0, standalone: false, ...over, down: down ?? over.down ?? null,
})

// DC-1 portrait 947x1163, landscape 1267x843, bottom inset 24 either way.
const DC1_P_DOWN = android({ innerWidth: 947, innerHeight: 1163, screenWidth: 948, visualWidth: 947, visualHeight: 1163, insetBottom: 24 })
const DC1_L_DOWN = android({ innerWidth: 1267, innerHeight: 843, screenWidth: 1268, visualWidth: 1267, visualHeight: 843, insetBottom: 24 })
const DC1_P = { innerHeight: 1163, insetBottom: 24 }
const DC1_L = { innerHeight: 843, insetBottom: 24 }

test('DC-1 portrait keyboard up: the grid holds and the keys lift by the dropped inset', () => {
  const down = deriveLayout(DC1_P_DOWN)
  const up = deriveLayout(android({ ...DC1_P_DOWN, visualHeight: 819, insetBottom: 0 }, DC1_P))
  assert.equal(down.keyboardUp, false)
  assert.equal(up.keyboardUp, true)
  assert.equal(up.stableHeight, down.stableHeight, 'the keyboard does not reflow the grid')
  assert.deepEqual(gridFor(up.terminal.width, up.stableHeight, CELL_DC1), { cols: 121, rows: 67 })
  // Chrome dropped the 24px inset without shrinking the window, so the visual
  // viewport runs 24px under the keyboard and the bar lifts its keys clear.
  assert.equal(up.keyBarPadBottom, 24)
  assert.equal(up.keyBarHeight, KEY_BAR_H + 24)
  assert.equal(up.appHeight, 819)
  assert.equal(up.terminal.height + up.keyBarHeight, 819, 'no gap anywhere')
})

test('DC-1 landscape keyboard up: the grid holds and the keys lift by the dropped inset', () => {
  const down = deriveLayout(DC1_L_DOWN)
  const up = deriveLayout(android({ ...DC1_L_DOWN, visualHeight: 499, insetBottom: 0 }, DC1_L))
  assert.equal(up.keyboardUp, true)
  assert.equal(up.stableHeight, down.stableHeight)
  assert.deepEqual(gridFor(up.terminal.width, up.stableHeight, CELL_DC1), { cols: 162, rows: 47 })
  assert.equal(up.keyBarPadBottom, 24)
  assert.equal(up.keyBarHeight, KEY_BAR_H + 24)
  assert.equal(up.terminal.height + up.keyBarHeight, 499)
})

test('DC-1 stale landscape turn: the grid stays landscape and the keys lift clear of the keyboard', () => {
  // Rotated with the keyboard up, Chrome turns the width at once but keeps the
  // portrait innerHeight (1163) and visual height (819). The remembered
  // landscape down sizes the grid and measures the lift against the keyboard.
  const l = deriveLayout(android({ innerWidth: 1267, innerHeight: 1163, screenWidth: 1268, visualWidth: 1267, visualHeight: 819, insetBottom: 0 }, DC1_L))
  assert.equal(l.keyboardUp, true)
  assert.equal(l.orientation, 'landscape')
  assert.equal(l.stableHeight, 765)
  assert.deepEqual(gridFor(l.terminal.width, l.stableHeight, CELL_DC1), { cols: 162, rows: 47 })
  assert.equal(l.keyBarPadBottom, 344, 'the keys lift to the keyboard top, not the stale visual bottom')
  assert.equal(l.keyBarHeight, KEY_BAR_H + 344)
})

test('DC-1 stale portrait turn: the grid survives, the lift is left at zero', () => {
  // The mirror case: width 947 but innerHeight (843) and visual height (499)
  // are still the landscape keyboard-up values. The remembered portrait down
  // keeps the grid right. The lift cannot be measured from a stale visual
  // viewport, so the keys end above the real keyboard — the gap the fuzzer
  // still reports, a Chrome limit rather than a layout choice.
  const l = deriveLayout(android({ innerWidth: 947, innerHeight: 843, screenWidth: 948, visualWidth: 947, visualHeight: 499, insetBottom: 0 }, DC1_P))
  assert.equal(l.keyboardUp, true)
  assert.equal(l.orientation, 'portrait')
  assert.equal(l.stableHeight, 1085)
  assert.deepEqual(gridFor(l.terminal.width, l.stableHeight, CELL_DC1), { cols: 121, rows: 67 })
  assert.equal(l.keyBarPadBottom, 0)
  assert.equal(l.appHeight, 499, 'the app is sized to the stale visual viewport')
})

test('DC-1 keyboard down with nothing remembered yet sizes from the reading itself', () => {
  // Startup before any settle: the keyboard is down and there is no `down`, so
  // the reading is its own reference and the grid is right. The keyboard-up
  // grid relies on the remembered down (a reload keeps it in sessionStorage).
  const l = deriveLayout(DC1_P_DOWN)
  assert.equal(l.keyboardUp, false)
  assert.deepEqual(gridFor(l.terminal.width, l.stableHeight, CELL_DC1), { cols: 121, rows: 67 })
})

test('emulator portrait keyboard up: the window shrinks by the inset, so the keys need no lift', () => {
  const down = android({ innerWidth: 411, innerHeight: 813, screenWidth: 411, visualWidth: 411, visualHeight: 813, insetBottom: 24 })
  const emDown = { innerHeight: 813, insetBottom: 24 }
  const up = deriveLayout(android({ ...down, innerHeight: 789, visualHeight: 476.95, insetBottom: 0 }, emDown))
  assert.equal(deriveLayout(down).keyboardUp, false)
  assert.equal(up.keyboardUp, true)
  assert.equal(up.stableHeight, deriveLayout(down).stableHeight, 'the grid holds')
  assert.deepEqual(gridFor(up.terminal.width, up.stableHeight, CELL_EM), { cols: 52, rows: 45 })
  // innerHeight fell by the 24px inset Chrome dropped, so nothing of the visual
  // viewport is under the keyboard and the bar keeps its plain height.
  assert.equal(up.keyBarPadBottom, 0)
  assert.equal(up.keyBarHeight, KEY_BAR_H)
})

test('emulator landscape: the grid is sized below the cutout Chrome keeps clear of', () => {
  const l = deriveLayout(android({ innerWidth: 869, innerHeight: 303, screenWidth: 924, visualWidth: 869, visualHeight: 303, insetBottom: 24, insetRight: 55 }))
  assert.equal(l.terminal.width, 869)
  assert.equal(l.stableHeight, 225)
  assert.deepEqual(gridFor(l.terminal.width, l.stableHeight, CELL_EM), { cols: 111, rows: 14 })
})

test('a same-width chrome shrink below the keyboard threshold stays keyboard-down', () => {
  // A small shrink is browser chrome, not a keyboard: the visual viewport
  // tracks the window, so there is no gap between them.
  const iosDown = { innerHeight: 714, insetBottom: 0 }
  const l = deriveLayout(android({ innerWidth: 402, innerHeight: 680, screenWidth: 402, visualWidth: 402, visualHeight: 680, insetBottom: 0 }, iosDown))
  assert.equal(l.keyboardUp, false)
  assert.equal(l.stableHeight, 680 - 10 - KEY_BAR_H, 'the grid follows the smaller window')
})
