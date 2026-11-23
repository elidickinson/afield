// `afield sessions` and `afield end`: read the supervisor's list and
// act on it, signed in with the same key the phone and attach use. A server that is
// not answering is an answer, not an error: say how to start one and leave.

import { keyHeaders, keyPath } from './auth.js'
import { ask, baseUrl, endOne, pickTarget, placeRow } from './picker.js'

/** The listed sessions and request headers, or null when no server answers. */
const reach = async url => {
  const headers = keyHeaders()
  const res = await fetch(new URL('/places', baseUrl(url)), { headers }).catch(() => null)
  if (!res) return null
  if (!res.ok) return { status: res.status }
  return { data: await res.json(), headers }
}

/** `afield sessions` — the sessions actually running, with ● and a count.
 *  Transcript history is the picker's business; this is what is live now. */
export async function sessions(url) {
  const result = await reach(url)
  if (!result) return noServer(url)
  if (result.status) return console.error(`could not list sessions (HTTP ${result.status})`)
  const live = result.data.sessions.filter(s => s.running)
  if (live.length === 0) return console.error('nothing is running')
  live.forEach((s, i) => console.log(placeRow(s, i + 1)))
}

/** `afield new [--shell]` — start a fresh session in the caller's folder,
 *  pi unless `kind` is `shell`. Returns the started session and the ws url to attach to, or nothing after saying why
 *  not. `attach` joins what exists; this starts one — in any directory the
 *  supervisor can see, since a joined session is a full bash prompt either way. */
export async function start(url, { cwd, kind, confirm = ask }) {
  const result = await reach(url)
  if (!result) return noServer(url)
  if (result.status) return console.error(result.status === 401
    ? `new: the server's sign-in key is not the one at ${keyPath()}`
    : `new: could not reach the server (HTTP ${result.status})`)
  const post = () => fetch(new URL('/start', baseUrl(url)), {
    method: 'POST',
    headers: { ...result.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, kind }),
  }).catch(() => null)
  let res = await post()
  if (!res) return noServer(url)
  if (res.status === 409) {
    if (!await endOne(url, result.headers, confirm)) return
    res = await post()
    if (!res) return noServer(url)
    if (res.status === 409) return console.error(`new: ${await res.text()}`)
  }
  // A 422 is the server naming what it refused: the folder, or the kind.
  if (!res.ok) return console.error(res.status === 422
    ? `new: ${await res.text()}`
    : `new: could not start a session (HTTP ${res.status})`)
  const { processId } = await res.json()
  return { processId, wsUrl: new URL('/ws', baseUrl(url)).toString() }
}

/** `afield end [fragment|n]` — end a running session for good, confirmed once. */
export async function end(url, { match, yes = false }) {
  const result = await reach(url)
  if (!result) return noServer(url)
  if (result.status) return console.error(`could not list sessions (HTTP ${result.status})`)
  const { data, headers } = result
  const running = data.sessions.filter(s => s.running)
  if (running.length === 0) return console.error('nothing is running')

  const target = await pickTarget(running, match)
  if (!target) return

  if (!yes) {
    const answer = (await ask(`end "${target.label || target.name}"? [y/N] `)).trim().toLowerCase()
    if (answer !== 'y' && answer !== 'yes') return console.error('left it running')
  }
  const res = await fetch(new URL(`/terminal?process=${encodeURIComponent(target.processId)}`, baseUrl(url)), {
    method: 'DELETE',
    headers,
  }).catch(() => null)
  if (!res) return console.error('could not reach the server')
  console.error(res.ok ? `ended: ${target.label || target.name}`
    : res.status === 404 ? 'it was already gone (nothing was running under that name)'
    : `could not end it (HTTP ${res.status})`)
}

const noServer = url => console.error(`server not started; run afield serve (connects to ${url})`)
