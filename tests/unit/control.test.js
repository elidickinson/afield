// `afield new`: the caller's cwd reaches POST /start, and the started
// session comes back as what attach needs. fetch is the external boundary —
// everything else here is real.
import test from 'node:test'
import assert from 'node:assert/strict'
import { start } from '../../server/control.js'

// No key file here, so no request carries a cookie.
process.env.XDG_CONFIG_HOME = '/nonexistent'

const intercept = calls => async (input, init = {}) => {
  const url = String(input instanceof URL ? input : input.url ?? input)
  if (url.endsWith('/places')) {
    return { ok: true, status: 200, json: async () => ({ sessions: [] }) }
  }
  if (url.endsWith('/start')) {
    calls.push({ url, method: 'POST', headers: init.headers, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ processId: 'fresh-process' }) }
  }
  throw new Error(`unexpected fetch ${url}`)
}

test('start posts the caller folder and returns what attach needs', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = intercept(calls)
  try {
    const result = await start('ws://127.0.0.1:7681', { cwd: '/work/here' })
    assert.deepEqual(calls, [{
      url: 'http://127.0.0.1:7681/start',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { cwd: '/work/here' },
    }])
    assert.deepEqual(result, { processId: 'fresh-process', wsUrl: 'http://127.0.0.1:7681/ws' })
  } finally {
    globalThis.fetch = realFetch
  }
})
test('start ends a picked session and retries the same kind once when the pool is full', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof URL ? input : input.url ?? input)
    calls.push({ url, method: init.method ?? 'GET', body: init.body && JSON.parse(init.body) })
    if (url.endsWith('/places')) return { ok: true, status: 200, json: async () => ({ sessions: [] }) }
    if (url.endsWith('/places?running=1')) return {
      ok: true, status: 200,
      json: async () => ({ sessions: [{ processId: 'old', label: 'old', running: true }] }),
    }
    if (url.endsWith('/start')) return calls.filter(c => c.url.endsWith('/start')).length === 1
      ? { ok: false, status: 409, text: async () => 'full' }
      : { ok: true, status: 200, json: async () => ({ processId: 'fresh' }) }
    if (url.includes('/terminal?process=old')) return { ok: true, status: 204 }
    throw new Error(`unexpected fetch ${url}`)
  }
  try {
    const result = await start('ws://127.0.0.1:7681', { cwd: '/work/here', kind: 'shell', confirm: async () => 'y' })
    assert.equal(result.processId, 'fresh')
    assert.deepEqual(calls.map(c => [c.url.split('/').at(-1), c.method]), [
      ['places', 'GET'], ['start', 'POST'], ['places?running=1', 'GET'],
      ['terminal?process=old', 'DELETE'], ['start', 'POST'],
    ])
    for (const post of calls.filter(c => c.url.endsWith('/start'))) {
      assert.deepEqual(post.body, { cwd: '/work/here', kind: 'shell' })
    }
  } finally {
    globalThis.fetch = realFetch
  }
})

test('start passes on what the server refused', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof URL ? input : input.url ?? input)
    if (url.endsWith('/places')) {
      return { ok: true, status: 200, json: async () => ({ sessions: [] }) }
    }
    return { ok: false, status: 422, text: async () => 'this server does not start pi sessions' }
  }
  const said = []
  const realError = console.error
  // Block body: the real console.error returns undefined, and start's
  // refusals return whatever console.error returned.
  console.error = line => { said.push(line) }
  try {
    assert.equal(await start('ws://127.0.0.1:7681', { cwd: '/work/here' }), undefined)
    assert.deepEqual(said, ['new: this server does not start pi sessions'])
  } finally {
    globalThis.fetch = realFetch
    console.error = realError
  }
})
test('start returns nothing when no server answers, so nothing attaches', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  const said = []
  const realError = console.error
  console.error = line => { said.push(line) }
  try {
    assert.equal(await start('ws://127.0.0.1:7681', { cwd: '/work/here' }), undefined)
    assert.deepEqual(said, ['server not started; run afield serve (connects to ws://127.0.0.1:7681)'])
  } finally {
    globalThis.fetch = realFetch
    console.error = realError
  }
})
