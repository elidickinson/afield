// Sign-in, for every connection unless `serve --no-sign-in`.
//
// There is one key per user, kept in the config folder, so `serve` and the CLI
// commands both read it. It is made the first time it is needed, unless you
// picked one with `afield set-key`. A browser signs in once, by typing the
// key `serve` prints into the sign-in page or opening the /login?key=… link in
// its QR code, and keeps a cookie made from it. A restart changes nothing; deleting the file or
// setting a new key signs every device out.
//
// It has to be a cookie. Basic auth cannot work here whatever the server does:
// Safari puts no Authorization header on a WebSocket handshake and the page has
// no way to add one, so the terminal would never connect. A cookie is the one
// credential a browser carries onto a handshake.
import { createHash, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const COOKIE = 'afield'
// The longest a browser keeps a cookie (Chrome's cap).
const MAX_AGE = 60 * 60 * 24 * 400

// A made key is short enough to type on a phone, with no 0/o or 1/l/i to mix
// up: 12 of these 30 characters is 59 bits, far past guessing over the network.
const ALPHABET = '23456789abcdefghjkmnpqrstvwxyz'
const KEY_LENGTH = 12

const digest = value => createHash('sha256').update(value).digest()
// Capitals, spaces and dashes don't count, so a key can be typed as printed
// on a phone keyboard.
const normalize = value => value.toLowerCase().replace(/[\s-]/g, '')
// What a browser keeps. Not the key itself, which may be a password used
// elsewhere and may hold characters a cookie cannot; slow to work back from.
const token = key => scryptSync(normalize(key), 'afield', 32).toString('base64url')

// Read on each call rather than once at import, so tests can point it elsewhere.
export const keyPath = () =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'afield', 'key')

/** This user's key, or undefined before any `serve` has needed one. */
export function readKey() {
  try {
    return readFileSync(keyPath(), 'utf8').trim()
  } catch (err) {
    if (err.code === 'ENOENT') return undefined
    throw err
  }
}

/** The key, made on first use and readable only by this user. */
export function ensureKey() {
  const existing = readKey()
  if (existing !== undefined) {
    // Otherwise anything that is all spaces and dashes would sign in.
    if (!normalize(existing)) throw new Error(`${keyPath()} has no key in it; delete it or run: afield set-key`)
    return existing
  }
  // In groups of four, as it is printed: easier to read off and type.
  const key = Array.from({ length: KEY_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)])
    .join('').match(/.{4}/g).join('-')
  mkdirSync(dirname(keyPath()), { recursive: true, mode: 0o700 })
  writeFileSync(keyPath(), `${key}\n`, { mode: 0o600, flag: 'wx' })
  return key
}

/** Request headers that sign in as this user, for the CLI commands. */
export function keyHeaders() {
  const key = readKey()
  return key ? { cookie: `${COOKIE}=${token(key)}` } : undefined
}

export class Auth {
  #key
  #token

  /** No key means no sign-in. */
  constructor(key) {
    if (key === undefined) return
    this.#key = normalize(key)
    this.#token = token(key)
  }

  get required() {
    return this.#key !== undefined
  }

  admits(req) {
    if (!this.required) return true
    const value = req.headers.cookie?.split(';')
      .map(part => part.trim())
      .find(part => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1)
    return Boolean(value) && timingSafeEqual(digest(value), digest(this.#token))
  }

  // Hashed before comparing so both sides are the same length, which is what
  // timingSafeEqual needs and what keeps the length of the real one quiet.
  accepts(attempt) {
    return timingSafeEqual(digest(normalize(attempt)), digest(this.#key))
  }

  // Strict: this cookie exists to open a shell, and no other site has any
  // business causing a request that carries it. Opening the QR link from the
  // camera, or submitting the form, is not another site's request, so the
  // cookie set there still rides the redirect to the page.
  cookie({ secure }) {
    return `${COOKIE}=${this.#token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}` +
      (secure ? '; Secure' : '')
  }
}

export const loginPage = (refused = false) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>afield</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="theme-color" content="#0b0b0d">
<style>
  html { color-scheme: dark }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
         background: #0b0b0d; color: #e8e8ea;
         font: 16px/1.4 ui-sans-serif, system-ui, sans-serif }
  form { display: grid; gap: 12px; width: min(20rem, 82vw) }
  input, button { font: inherit; padding: 12px; border-radius: 10px; border: 1px solid #303036 }
  input { background: #17171b; color: inherit }
  button { background: #2b6cb0; color: #fff; border-color: transparent }
  p { margin: 0; font-size: 14px; color: #9a9aa2 }
  .refused { color: #ff6b6b }
</style>
</head>
<body>
<form method="post" action="/login">
  ${refused ? '<p class="refused">That key is wrong.</p>' : ''}
  <input name="key" placeholder="sign-in key" aria-label="sign-in key"
         autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" autofocus>
  <button type="submit">Sign in</button>
  <p>afield printed the key, and a QR code that signs in, when it started.</p>
</form>
</body>
</html>
`
