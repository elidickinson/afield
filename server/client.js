// The client is one document: JS, CSS, and the VT core's WASM (already base64
// inside @wterm/core) inlined into the HTML. One file means one thing for the
// cache to be right or wrong about, which is what makes the build-id check at
// startup enough on its own.
//
// It is built per request rather than into dist/. A document built from the
// source on disk at the moment it is asked for cannot be stale, so there is no
// staleness to detect, and editing the client needs no restart — which matters
// because a restart would kill pi.
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const at = path => fileURLToPath(new URL(path, root))

// The client knows nothing about which theme was baked in beyond what the
// served HTML carries as a class on <html>.
const THEMES = {
  dark: { className: 'theme-dark', color: '#0b0b0d' },
  light: { className: 'theme-light', color: '#fafafa' },
}

/**
 * Returns the page and its ETag, which is a hash of everything that went into
 * it. Identical source gives an identical tag, so an unchanged client answers
 * a launch with a 304 instead of 74 KB.
 */
export async function buildClient({ theme = 'dark', scrollback }) {
  const themes = THEMES[theme] ?? THEMES.dark
  const bundled = await build({
    entryPoints: [at('src/app.js')],
    absWorkingDir: at('.'),
    tsconfig: at('tsconfig.json'),
    bundle: true,
    format: 'esm',
    target: 'safari17',
    minify: true,
    write: false,
  })
  const js = bundled.outputFiles[0].text
  const [html, wtermCss, css] = await Promise.all([
    readFile(at('src/index.html'), 'utf8'),
    readFile(at('vendor/wterm/packages/@wterm/dom/src/terminal.css'), 'utf8'),
    readFile(at('src/style.css'), 'utf8'),
  ])

  // Hashed before the stamp goes in, since the stamp is part of the page. The
  // theme and scrollback are hashed too: a page built for one setting must
  // never be served for another off the same ETag.
  const hash = createHash('sha256')
  for (const part of [js, html, wtermCss, css, theme, String(scrollback)]) hash.update(part)
  const id = hash.digest('base64url').slice(0, 12)

  const page = html
    .replace('%BUILD_ID%', id)
    .replace('%THEME_CLASS%', themes.className)
    .replace('%THEME_COLOR%', themes.color)
    .replace('%SCROLLBACK%', String(scrollback))
    .replace('/*%CSS%*/', () => `${wtermCss}\n${css}`)
    .replace('/*%JS%*/', () => js)
  return { page, etag: `"${id}"` }
}
