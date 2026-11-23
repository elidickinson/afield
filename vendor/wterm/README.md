# wterm (vendored fork)

A trimmed, modified fork of [vercel-labs/wterm](https://github.com/vercel-labs/wterm), vendored for afield under Apache-2.0 (see LICENSE). Imported at upstream commit `4a73024d9f9003972f9efa6fe1a9086d1c90417b` (`@wterm/dom` 0.3.4). Only `packages/@wterm/dom/src` is kept, because that is all afield renders through; the WASM engine (`@wterm/core`) comes from npm, not from this tree.

The modified files are `packages/@wterm/dom/src/input.ts`, `renderer.ts`, and `wterm.ts`, each marked at the top. The changes adapt the renderer to mobile keyboards: composition and swipe-typing input via a field-mirror delta engine, QuickPath separator emulation, backspace stand-aside, a caret kept at the field's end for Chrome on Android, a `keyChord` hook so sticky modifiers reach keyboards without real keydowns, page keys, reflowing text zoom, and `followOutput`/`onAfterPaint` hooks. `git log -p -- vendor/wterm` shows the changes from upstream, and [docs/design.md](../../docs/design.md) explains how the fork fits the client.

Upstream syncs are manual: this tree no longer matches upstream's layout, so diff against the import commit above rather than pulling a subtree.
