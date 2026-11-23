// The supervisor: what used to be "switching" is now "which of several
// sessions, kept running in the background, is this viewer looking at" — so
// these are the tests for background persistence and concurrent sessions that
// used to live in server.test.js's switching section.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createSupervisor } from '../../server/supervisor.js'
import { until } from '../until.js'

const cliPath = fileURLToPath(new URL('../../server/cli.js', import.meta.url))
const fakePi = fileURLToPath(new URL('../fixtures/fake-pi.js', import.meta.url))
const fakeShell = fileURLToPath(new URL('../fixtures/fake-shell.sh', import.meta.url))

/** A store like pi's, one session file per (folder, id) pair. */
const storeFor = async entries => {
  const root = await realpath(await mkdtemp(pathJoin(tmpdir(), 'afield-sup-')))
  const sessionDir = pathJoin(root, 'sessions')
  await mkdir(sessionDir)
  for (const { name, id, parent } of entries) {
    const cwd = pathJoin(root, name)
    await mkdir(cwd, { recursive: true })
    const dir = pathJoin(sessionDir, `-${cwd.replaceAll('/', '-')}-`)
    await mkdir(dir, { recursive: true })
    const header = { type: 'session', version: 3, id, cwd }
    if (parent) header.parentSession = pathJoin(dir, `${parent}.jsonl`)
    await writeFile(pathJoin(dir, `${id}.jsonl`), `${JSON.stringify(header)}\n`)
  }
  return {
    root, sessionDir, at: name => pathJoin(root, name),
    file: (name, id) => pathJoin(sessionDir, `-${pathJoin(root, name).replaceAll('/', '-')}-`, `${id}.jsonl`),
  }
}

const start = async ({ sessionDir, cap, socketDir, command = fakePi, args = [], shell, noPi, pingMs, childReadyMs, cli = cliPath, key, theme }) => {
  const supervisor = createSupervisor({
    port: 0, bind: '127.0.0.1', pi: noPi ? undefined : { command, args }, shell, cliPath: cli, sessionDir, cap, pingMs, childReadyMs, key, theme,
    socketDir: socketDir ?? await mkdtemp(pathJoin(tmpdir(), 'afield-sock-')),
  })
  await new Promise(r => supervisor.http.on('listening', r))
  const { port } = supervisor.http.address()
  return { supervisor, base: `ws://127.0.0.1:${port}/ws`, page: `http://127.0.0.1:${port}` }
}

/** Join a session, collecting its screen output as text. */
const join = (base, id, { columns = 50, rows = 20, cwd, processId } = {}) => {
  const query = [processId && `process=${processId}`, id && `session=${id}`, cwd && `cwd=${encodeURIComponent(cwd)}`].filter(Boolean).join('&')
  const ws = new WebSocket(`${base}?${query}`, ['tty'])
  let output = ''
  const opened = new Promise(resolve => ws.on('open', () => {
    ws.send(JSON.stringify({ columns, rows }))
    resolve()
  }))
  const closeDetails = new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  const closed = closeDetails.then(({ code }) => code)
  ws.on('message', d => { if (Buffer.from(d)[0] === 0x30) output += Buffer.from(d).subarray(1).toString() })
  return {
    opened, closed, closeDetails, ws,
    get output() { return output },
    send: text => ws.send(Buffer.concat([Buffer.from([0x30]), Buffer.from(text)])),
    close: () => ws.close(),
  }
}

const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms))

test('joining a known session spawns it and serves its screen', async () => {
  const store = await storeFor([{ name: 'target-project', id: 'a' }])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'a')
  try {
    await viewer.opened
    // fake-pi draws its own cwd, so the screen says where the program landed.
    await until(() => viewer.output.includes('target-project'), 'the session\'s own folder')
  } finally {
    viewer.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('joining an id the server never listed is refused', async () => {
  const store = await storeFor([{ name: 'known', id: 'a' }])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'not-a-real-id')
  try {
    const code = await viewer.closed
    assert.equal(code, 4004)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a session that cannot be reached is refused with its own code', async () => {
  const store = await storeFor([{ name: 'known', id: 'a' }])
  // A child that is running but never listens: the join waits, gives up,
  // and says so distinctly from a conversation that does not exist.
  const cli = pathJoin(store.root, 'silent-cli.js')
  await writeFile(cli, 'setInterval(() => {}, 1_000)\n')
  const { supervisor, base } = await start({ sessionDir: store.sessionDir, cli, childReadyMs: 300 })
  const viewer = join(base, 'a')
  try {
    const { code, reason } = await viewer.closeDetails
    // The server stamps a leave when its side of the close lands, which can be
    // after the client has seen its own.
    await settle()
    const [child] = supervisor.registry.running()
    assert.equal(code, 4005)
    assert.match(reason, /could not reach/)
    // A join that never attached leaves what it did not see unread.
    assert.equal(child.seenAt, child.joinedAt)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('two sessions run at once, each its own screen', async () => {
  const store = await storeFor([{ name: 'alpha', id: 'a' }, { name: 'beta', id: 'b' }])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir })
  const a = join(base, 'a')
  const b = join(base, 'b')
  try {
    await Promise.all([a.opened, b.opened])
    await until(() => a.output.includes('alpha'), 'the first session\'s folder')
    await until(() => b.output.includes('beta'), 'the second session\'s folder')
    assert.equal(a.output.includes('beta'), false, 'one session\'s screen does not leak into the other\'s')
    assert.equal(b.output.includes('alpha'), false)
  } finally {
    a.close(); b.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('GET /places?running=1 orders unwatched then quietest', async () => {
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'b' }, { name: 'three', id: 'c' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const watched = join(base, 'a')
  try {
    await watched.opened
    for (const [id, name] of [['b', 'two'], ['c', 'three']]) {
      const viewer = join(base, id)
      await viewer.opened
      await until(() => viewer.output.includes(name), `session ${name} to be running`)
      viewer.close()
      await viewer.closed
    }
    const children = Object.fromEntries(supervisor.registry.running().map(child => [child.sessionId, child]))
    const future = Date.now() + 60_000
    children.a.joinedAt = future + 30
    children.b.joinedAt = future + 20
    children.c.joinedAt = future + 10
    children.a.lastOutputAt = future + 10
    children.b.lastOutputAt = future + 20
    children.c.lastOutputAt = future + 30
    const { sessions } = await fetch(`${page}/places?running=1`).then(r => r.json())
    assert.equal(typeof sessions[0].startedAt, 'number')
    assert.deepEqual(sessions.map(s => s.id), ['b', 'c', 'a'])
    assert.deepEqual(sessions.map(s => s.active), [future + 20, future + 30, future + 10])
  } finally {
    watched.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('GET /places lists every session and which ones are running', async () => {
  const store = await storeFor([{ name: 'alpha', id: 'a' }, { name: 'beta', id: 'b' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const a = join(base, 'a')
  try {
    await a.opened
    await until(() => a.output.length > 0, 'the joined session to be up')

    const { sessions } = await fetch(`${page}/places`).then(r => r.json())
    // beta holds the newer transcript, so only a running-first list puts the
    // joined alpha on top.
    assert.equal(sessions[0].id, 'a', 'the running session is listed first')
    const byId = Object.fromEntries(sessions.map(s => [s.id, s]))
    assert.equal(byId.a.running, true, 'the session that was joined is running')
    assert.equal(byId.a.viewers, 1, 'the open join is counted')
    assert.equal(byId.b.running, false, 'the one nobody joined is not')
    assert.equal(byId.b.viewers, 0, 'an unjoined session has no viewers')

    // The exact-id answer of a running listed session reads the same way.
    const named = await fetch(`${page}/places?id=a`).then(r => r.json())
    assert.equal(named.sessions[0].running, true)
    assert.equal(named.sessions[0].viewers, 1)
  } finally {
    a.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a rebound name cannot read the session list or browse folders', async () => {
  const store = await storeFor([{ name: 'alpha', id: 'a' }])
  const { supervisor, page } = await start({ sessionDir: store.sessionDir })
  // Both headers say evil.example: what DNS rebinding produces, and
  // same-origin to the browser, so only the Host clause of the gate stops it.
  // fetch() drops a custom Host, so this asks over raw http.
  const rebound = { origin: 'http://evil.example', host: 'evil.example' }
  const status = path => new Promise(resolve =>
    http.get(`${page}${path}`, { headers: rebound }, res => { res.resume(); resolve(res.statusCode) }))
  try {
    assert.equal(await status('/places'), 403)
    assert.equal(await status(`/subfolders?cwd=${encodeURIComponent(store.root)}`), 403)
    assert.equal((await fetch(`${page}/places`)).status, 200, 'a caller without Origin still lists')
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a turn that ends while unwatched is working, then unread in both listings', async () => {
  const store = await storeFor([{ name: 'live', id: 'a' }, { name: 'saved', id: 'b' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'a')
  const list = async () => (await fetch(`${page}/places?running=1`).then(r => r.json())).sessions[0]
  try {
    await viewer.opened
    await until(() => viewer.output.length > 0, 'the session to be running')
    viewer.send('/turn 1000\r')
    await until(async () => (await list()).working, 'the turn to start')
    viewer.close()
    await viewer.closed
    assert.equal((await list()).unread, false, 'not unread while still working')

    await until(async () => !(await list()).working, 'the turn to end')
    assert.equal((await list()).unread, true)
    const plain = await fetch(`${page}/places`).then(r => r.json())
    const byId = Object.fromEntries(plain.sessions.map(s => [s.id, s]))
    assert.equal(byId.a.unread, true)
    assert.equal('unread' in byId.b, false)
  } finally {
    viewer.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a turn that ends while watched stays read after leaving', async () => {
  const store = await storeFor([{ name: 'work', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'a')
  const list = async () => (await fetch(`${page}/places?running=1`).then(r => r.json())).sessions[0]
  try {
    await viewer.opened
    await until(() => viewer.output.length > 0, 'the session to be running')
    viewer.send('/turn 200\r')
    await until(async () => (await list()).working, 'the turn to start')
    await until(async () => !(await list()).working, 'the turn to end')
    viewer.close()
    await viewer.closed
    assert.equal((await list()).unread, false)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('subagents keep a session working after its run ends, and it is unread once they stop', async () => {
  const store = await storeFor([{ name: 'work', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'a')
  const list = async () => (await fetch(`${page}/places?running=1`).then(r => r.json())).sessions[0]
  try {
    await viewer.opened
    await until(() => viewer.output.length > 0, 'the session to be running')
    viewer.send('/turn 200\r/subagents 3000\r')
    await until(async () => (await list()).working, 'the turn to start')
    viewer.close()
    await viewer.closed
    // Past the end of the run and the hold behind it: the subagents are what keep it working.
    await settle(2_000)
    assert.equal((await list()).working, true)

    await until(async () => !(await list()).working, 'the subagents to finish')
    assert.equal((await list()).unread, true)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('blocking on a dialog while unwatched is unread, even with subagents running', async () => {
  const store = await storeFor([{ name: 'work', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'a')
  const list = async () => (await fetch(`${page}/places?running=1`).then(r => r.json())).sessions[0]
  try {
    await viewer.opened
    await until(() => viewer.output.length > 0, 'the session to be running')
    viewer.send('/subagents 10000\r/block 2000\r')
    await until(async () => (await list()).working, 'the run to start')
    viewer.close()
    await viewer.closed

    await until(async () => (await list()).unread, 'the dialog to count as stopped')
    assert.equal((await list()).working, false)
    await until(async () => (await list()).working, 'the run to go on after the dialog')
    assert.equal((await list()).unread, false)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a dialog opening on an idle pi while unwatched is unread', async () => {
  const store = await storeFor([{ name: 'work', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'a')
  const list = async () => (await fetch(`${page}/places?running=1`).then(r => r.json())).sessions[0]
  try {
    await viewer.opened
    await until(() => viewer.output.length > 0, 'the session to be running')
    viewer.send('/ask 500\r')
    viewer.close()
    await viewer.closed

    await until(async () => (await list()).unread, 'the dialog to count as stopped')
    assert.equal((await list()).working, false)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('/places hides forks from the list but answers them by exact id', async () => {
  const store = await storeFor([{ name: 'main', id: 'a' }, { name: 'main', id: 'b', parent: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  try {
    const { sessions } = await fetch(`${page}/places`).then(r => r.json())
    assert.deepEqual(sessions.map(s => s.id), ['a'], 'the fork is not a row of the list')

    const exact = await fetch(`${page}/places?id=b`).then(r => r.json())
    assert.deepEqual(exact.sessions.map(s => s.id), ['b'], 'the fork is answered by id')
    assert.equal(exact.sessions[0].cwd, store.at('main'))
    assert.equal(exact.more, false)

    const missing = await fetch(`${page}/places?id=zzz`).then(r => r.json())
    assert.deepEqual(missing.sessions, [], 'an unknown id is an empty answer, not an error')
    const junk = await fetch(`${page}/places?id=..%2Fescape`).then(r => r.json())
    assert.deepEqual(junk.sessions, [], 'an id outside the id shape is an empty answer, not an error')

    // Joined, the fork reads like any row: running, and watched.
    const viewer = join(base, 'b', { cwd: store.at('main') })
    try {
      await viewer.opened
      await until(() => viewer.output.includes('main'), 'the forked session to be served')
      const running = await fetch(`${page}/places?id=b`).then(r => r.json())
      assert.equal(running.sessions[0].running, true)
      assert.equal(running.sessions[0].viewers, 1)
    } finally {
      viewer.close()
    }
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('/places scopes viewers to the exact folder when an id is listed twice', async () => {
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'a', { cwd: store.at('two') })
  try {
    await viewer.opened
    await until(() => viewer.output.includes('two'), 'the selected folder to be served')

    const { sessions } = await fetch(`${page}/places`).then(r => r.json())
    const byCwd = Object.fromEntries(sessions.map(s => [s.cwd, s]))
    assert.equal(byCwd[store.at('one')].viewers, 0)
    assert.equal(byCwd[store.at('two')].viewers, 1)
    assert.equal(byCwd[store.at('two')].running, true)
  } finally {
    viewer.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('/places pages rows and still shows an unpaged caller every running session', async () => {
  // `afield end` reads this with no window and must never be looking at a
  // list that omits a running one, so the window is the phone's alone.
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'b' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'b', { cwd: store.at('two') })
  try {
    await viewer.opened
    await until(() => viewer.output.includes('two'), 'the session to be running')

    const first = await fetch(`${page}/places?limit=1`).then(r => r.json())
    assert.equal(first.more, true, 'one row held back from the first page')
    const second = await fetch(`${page}/places?offset=${first.offset}&limit=1`).then(r => r.json())
    assert.equal(second.more, false)
    assert.deepEqual([...first.sessions, ...second.sessions].map(s => s.cwd).sort(),
      [store.at('one'), store.at('two')], 'the two pages hold the two rows')

    const everything = await fetch(`${page}/places`).then(r => r.json())
    assert.equal(everything.more, false, 'no window means nothing is held back')
    assert.deepEqual(everything.sessions.filter(s => s.running).map(s => s.cwd), [store.at('two')])
  } finally {
    viewer.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a conversation past the newest fifty is still joined by id', async () => {
  // A join names one conversation; which window of the list it fell in is not
  // a question it should have to answer.
  const store = await storeFor([{ name: 'work', id: 'old' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const dir = pathJoin(store.sessionDir, `-${store.at('work').replaceAll('/', '-')}-`)
  const old = Date.UTC(2020, 0, 1)
  await utimes(pathJoin(dir, 'old.jsonl'), old, old)
  for (let i = 0; i < 52; i++) {
    await writeFile(pathJoin(dir, `noise-${i}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id: `noise-${i}`, cwd: store.at('work') })}\n`)
  }
  const viewer = join(base, 'old', { cwd: store.at('work') })
  try {
    await viewer.opened
    await until(() => viewer.output.includes('work'), 'the old conversation to serve its screen')
  } finally {
    viewer.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('DELETE ends one running session and closes its viewer', async () => {
  const store = await storeFor([{ name: 'work', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'a')
  try {
    await viewer.opened
    await until(() => viewer.output.length > 0, 'the joined session to be up')
    await until(async () => {
      const { sessions } = await fetch(`${page}/places`).then(r => r.json())
      return sessions.find(s => s.id === 'a')?.viewers === 1
    }, 'the viewer to appear in the list')

    const { sessions } = await fetch(`${page}/places`).then(r => r.json())
    const processId = sessions.find(s => s.id === 'a').processId
    const refused = await fetch(`${page}/terminal?process=${processId}`, {
      method: 'DELETE', headers: { origin: 'https://attacker.example' },
    })
    assert.equal(refused.status, 403)
    assert.equal(registryRunning(supervisor), 1)

    const ended = await fetch(`${page}/terminal?process=${processId}`, { method: 'DELETE' })
    assert.equal(ended.status, 200)
    assert.deepEqual(await ended.json(), { ended: processId })
    await until(() => registryRunning(supervisor) === 0, 'the child to exit')
    assert.equal(await viewer.closed, 1001, 'the connected viewer sees the session end')
    assert.equal((await viewer.closeDetails).reason, 'ended by a terminal')

    assert.equal((await fetch(`${page}/terminal?process=${processId}`, { method: 'DELETE' })).status, 404)
    assert.equal((await fetch(`${page}/terminal`, { method: 'DELETE' })).status, 404)
    // A phone that slept through the end, asking for it and its conversation.
    assert.equal(await join(base, 'a', { processId, cwd: store.at('work') }).closed, 4004)
  } finally {
    viewer.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('after a restart, a process from the last run reopens its conversation', async () => {
  const store = await storeFor([{ name: 'work', id: 'a' }])
  const first = await start({ sessionDir: store.sessionDir })
  const second = { supervisor: null }
  try {
    const viewer = join(first.base, 'a')
    await until(() => registryRunning(first.supervisor) === 1, 'the first run\'s session')
    const [old] = first.supervisor.registry.running()
    await first.supervisor.close()
    await viewer.closed

    Object.assign(second, await start({ sessionDir: store.sessionDir }))
    // Without the conversation there is nothing to reopen.
    assert.equal(await join(second.base, null, { processId: old.processId }).closed, 4004)
    const back = join(second.base, 'a', { processId: old.processId, cwd: store.at('work') })
    await until(() => back.output.includes('work'), 'the conversation reopened')
    const [now] = second.supervisor.registry.running()
    assert.notEqual(now.processId, old.processId)
    assert.equal(second.supervisor.registry.current(now).id, 'a')
    back.close()
  } finally {
    await second.supervisor?.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('pi exiting on its own reports a neutral close reason', async () => {
  const store = await storeFor([{ name: 'work', id: 'a' }])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir })
  const viewer = join(base, 'a')
  try {
    await viewer.opened
    await until(() => viewer.output.includes('work'), 'the session to be up')
    viewer.send('/quit\r')
    const closed = await viewer.closeDetails
    assert.equal(closed.code, 1001)
    assert.equal(closed.reason, 'pi exited')
  } finally {
    viewer.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a full pool refuses a join rather than ending a watched session', async () => {
  // Cap one, one session up and still on somebody's screen: the join that
  // would need the room is refused instead, and the viewer keeps what it has.
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'b' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir, cap: 1 })
  const a = join(base, 'a')
  try {
    await a.opened
    await until(() => a.output.includes('one'), 'the first session up')

    const b = join(base, 'b')
    const { code, reason } = await b.closeDetails
    assert.equal(code, 4006, 'the join is refused rather than anything being ended')
    assert.equal(reason, '1 sessions are running (the limit); end one first')
    const { sessions } = await fetch(`${page}/places`).then(r => r.json())
    assert.equal(sessions.find(s => s.id === 'a').running, true, 'the watched session is untouched')
    a.send('hello\r')
    await until(() => a.output.includes('ok: 5 chars'), 'the viewer still has its terminal')
  } finally {
    a.close()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('two folders with the same conversation id get separate PTYs', async () => {
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  try {
    const first = join(base, 'a', { cwd: store.at('one') })
    await first.opened
    const second = join(base, 'a', { cwd: store.at('two') })
    await second.opened
    await until(() => first.output.includes('one') && second.output.includes('two'), 'each folder to serve its own screen')
    const { sessions } = await fetch(`${page}/places`).then(r => r.json())
    assert.equal(new Set(sessions.map(s => s.processId)).size, 2)
    assert.equal(registryRunning(supervisor), 2)
    first.close()
    second.close()
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('/start begins a session in any directory that exists', async () => {
  const store = await storeFor([{ name: 'listed', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir })
  const post = (body) => fetch(`${page}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const fresh = await mkdtemp(pathJoin(tmpdir(), 'afield-new-'))
  try {
    // A folder that does not exist is refused, spawning nothing.
    const refused = await post({ cwd: pathJoin(store.root, 'elsewhere') })
    assert.equal(refused.status, 422)
    assert.equal(registryRunning(supervisor), 0)

    // A folder that was never a place and is not this server's own still
    // spawns: `afield new` runs it in any project folder the user is in.
    const ok = await post({ cwd: fresh })
    assert.equal(ok.status, 200)
    const { id, cwd, processId } = await ok.json()
    assert.match(id, /^[0-9a-f-]{36}$/)
    assert.equal(cwd, await realpath(fresh))
    const viewer = join(base, id, { processId })
    await viewer.opened
    await until(() => viewer.output.length > 0, 'the started session serves its screen')
    viewer.close()

    // A folder the listing offers still works as it always did.
    const listed = await post({ cwd: store.at('listed') })
    assert.equal(listed.status, 200)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
    await rm(fresh, { recursive: true, force: true })
  }
})

const postStart = (page, body) => fetch(`${page}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('/start runs a login shell when asked, and only a kind this server offers', async () => {
  const store = await storeFor([{ name: 'listed', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir, shell: fakeShell })
  try {
    const refused = await postStart(page, { cwd: store.at('listed'), kind: 'htop' })
    assert.equal(refused.status, 422)
    assert.equal(registryRunning(supervisor), 0)

    const ok = await postStart(page, { cwd: store.at('listed'), kind: 'shell' })
    assert.equal(ok.status, 200)
    const { id, processId } = await ok.json()
    const viewer = join(base, id, { processId })
    await viewer.opened
    // The shell says what it was given: -l, and none of pi's flags.
    await until(() => /fake-shell ready: -l\x1b/.test(viewer.output), 'the shell having run')
    viewer.close()

    // The list says what can be started, and which running row is a terminal.
    const places = await fetch(`${page}/places`).then(r => r.json())
    assert.deepEqual(places.kinds, ['pi', 'shell'])
    const row = places.sessions.find(s => s.processId === processId)
    assert.equal(row.kind, 'shell')
    assert.equal(row.label, 'fake-shell.sh · listed')
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a server with no pi lists no conversations and starts only terminals', async () => {
  const store = await storeFor([{ name: 'saved', id: 'a' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir, shell: fakeShell, noPi: true })
  try {
    const places = await fetch(`${page}/places`).then(r => r.json())
    assert.deepEqual(places.kinds, ['shell'])
    assert.deepEqual(places.sessions, [])
    assert.equal((await postStart(page, { cwd: store.at('saved') })).status, 422)
    assert.equal(await join(base, 'a').closed, 4004)
    assert.equal(registryRunning(supervisor), 0)

    const ok = await postStart(page, { cwd: store.at('saved'), kind: 'shell' })
    assert.equal(ok.status, 200)
    const viewer = join(base, null, { processId: (await ok.json()).processId })
    await until(() => viewer.output.includes('fake-shell ready'), 'the shell having run')
    viewer.close()
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a /start body that is not JSON is refused, and the server stays up', async () => {
  const store = await storeFor([{ name: 'listed', id: 'a' }])
  const { supervisor, page } = await start({ sessionDir: store.sessionDir })
  try {
    for (const body of ['not json', JSON.stringify({ cwd: 5 })]) {
      const res = await fetch(`${page}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      assert.equal(res.status, 422)
    }
    assert.equal((await fetch(`${page}/places`)).status, 200)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('/start answers 503 when the server cannot spawn at all', async () => {
  // spawn() refusing outright is the machine failing, not the request: it says
  // so as a 503 to retry later, where a bare 500 would blame the request. A
  // command line longer than the OS will exec makes the fork itself fail,
  // which is the same path as running out of file descriptors.
  const store = await storeFor([{ name: 'listed', id: 'a' }])
  const { supervisor, page } = await start({ sessionDir: store.sessionDir, cli: pathJoin(tmpdir(), 'x'.repeat(2 * 1024 * 1024)) })
  try {
    const res = await fetch(`${page}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: store.at('listed') }),
    })
    assert.equal(res.status, 503)
    assert.match(await res.text(), /cannot start a terminal/)
    assert.equal(registryRunning(supervisor), 0)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('/subfolders lists the folders inside one and refuses one that is gone', async () => {
  const store = await storeFor([{ name: 'listed', id: 'a' }])
  const { supervisor, page } = await start({ sessionDir: store.sessionDir })
  const deep = pathJoin(store.at('listed'), 'deep')
  await mkdir(deep)
  try {
    const found = await fetch(`${page}/subfolders?cwd=${encodeURIComponent(store.at('listed'))}`).then(r => r.json())
    assert.equal(found.cwd, store.at('listed'))
    assert.deepEqual(found.dirs, [deep])
    assert.equal(found.parent, store.root)

    const missing = await fetch(`${page}/subfolders?cwd=${encodeURIComponent(pathJoin(store.root, 'gone'))}`)
    assert.equal(missing.status, 404)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

/** How many children the supervisor's registry is holding. */
const registryRunning = supervisor => supervisor.registry.running().length

test('rejoining a still-running session at a full cap keeps it running', async () => {
  const store = await storeFor([{ name: 'one', id: 'a' }, { name: 'two', id: 'b' }])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir, cap: 2 })
  const a = join(base, 'a')
  try {
    await a.opened
    await until(() => a.output.includes('one'), 'the first session up')
    a.send('hello\r')
    await until(() => a.output.includes('ok: 5 chars'), 'the line landing')
    a.close()
    await a.closed

    const b = join(base, 'b')
    await b.opened
    await until(() => b.output.includes('two'), 'the second session up')
    b.close()
    await b.closed

    // Rejoining serves the process already running -- its in-memory history is
    // the proof -- without ending anything.
    const again = join(base, 'a')
    await again.opened
    await until(() => again.output.includes('ok: 5 chars'), 'the earlier line, still there')
    const { sessions } = await fetch(`${page}/places`).then(r => r.json())
    const running = Object.fromEntries(sessions.map(s => [s.id, s.running]))
    assert.deepEqual(running, { a: true, b: true })
    again.close()
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a viewer that stops answering pings is dropped, not counted forever', async () => {
  const store = await storeFor([{ name: 'work', id: 'a' }])
  // Ping every 200ms: the round that notices the dead socket is fast enough
  // to wait for in a test.
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir, pingMs: 200 })
  const web = join(base, 'a', { columns: 100, rows: 30 })
  let cli
  try {
    await web.opened
    await until(() => web.output.includes('100x30'), 'the wide grid')
    cli = join(base, 'a', { columns: 40, rows: 12 })
    await cli.opened
    await until(() => cli.output.includes('40x12'), 'the narrow viewer to resize the session')

    // The web viewer is killed mid-tunnel: the TCP socket stays up and nothing
    // ever answers the pings. The ping loop must notice or /places counts it
    // forever.
    web.ws._socket.pause()
    await until(async () => {
      const { sessions } = await fetch(`${page}/places`).then(r => r.json())
      return sessions.find(s => s.id === 'a')?.viewers === 1
    }, 'the dead viewer to stop counting')
  } finally {
    cli?.close()
    web.ws.terminate()
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('the home-screen icon answers without a login', async () => {
  const store = await storeFor([])
  const { supervisor, page } = await start({ sessionDir: store.sessionDir, key: 'k3y' })
  try {
    // iOS fetches the icon with no cookie when the page is added to the Home
    // screen, so sign-in must not stand in front of it.
    const res = await fetch(`${page}/apple-touch-icon.png`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    const served = Buffer.from(await res.arrayBuffer())
    const icon = await readFile(fileURLToPath(new URL('../../src/apple-touch-icon.png', import.meta.url)))
    assert.equal(served.equals(icon), true)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('the document validates against its build id, so an unchanged client costs a 304', async () => {
  const store = await storeFor([])
  const { supervisor, page } = await start({ sessionDir: store.sessionDir })
  try {
    const first = await fetch(page)
    const etag = first.headers.get('etag')
    assert.equal(first.status, 200)
    assert.ok(etag, 'the document carries a validator')
    // One value does both jobs: what the cache validates against is what the
    // client compares itself to.
    assert.match(await first.text(), new RegExp(`<meta name="build" content="${etag.slice(1, -1)}">`))

    const again = await fetch(page, { headers: { 'if-none-match': etag } })
    assert.equal(again.status, 304)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('--theme light serves a light page with its own ETag, so no theme leaks across the cache', async () => {
  const store = await storeFor([])
  const light = await start({ sessionDir: store.sessionDir, theme: 'light' })
  const dark = await start({ sessionDir: store.sessionDir })
  try {
    const lightRes = await fetch(light.page)
    const lightBody = await lightRes.text()
    assert.match(lightBody, /<html lang="en" class="theme-light">/)
    assert.match(lightBody, /name="theme-color" content="#fafafa"/)

    const darkRes = await fetch(dark.page)
    assert.match(await darkRes.text(), /<html lang="en" class="theme-dark">/)
    // The two themes share the same source, so without them in the hash their
    // docs would get one ETag between them — and the cache would serve a
    // light page for a dark request. The hash has to know the theme.
    const lightEtag = lightRes.headers.get('etag')
    const darkEtag = darkRes.headers.get('etag')
    assert.ok(lightEtag && darkEtag, 'both themes carry a validator')
    assert.notEqual(lightEtag, darkEtag)
  } finally {
    await light.supervisor.close()
    await dark.supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

/** Just the handshake: was this socket let up at all? */
const handshake = (url, options) => new Promise(resolve => {
  const ws = new WebSocket(url, ['tty'], options)
  ws.on('open', () => { ws.close(); resolve('opened') })
  ws.on('error', () => resolve('refused'))
})

test('a socket from another origin never reaches a session', async () => {
  const store = await storeFor([])
  const { supervisor, base } = await start({ sessionDir: store.sessionDir })
  try {
    assert.equal(await handshake(base, { origin: 'http://evil.example' }), 'refused',
      'a hostile page got a terminal')
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('a key puts sign-in in front of both the page and the socket', async () => {
  const store = await storeFor([])
  const { supervisor, base, page } = await start({ sessionDir: store.sessionDir, key: 'k3y' })
  const signIn = key => fetch(`${page}/login?key=${key}`, { redirect: 'manual' })
  try {
    assert.doesNotMatch(await (await fetch(page)).text(), /name="build"/,
      'the terminal was served to someone who has not signed in')
    assert.equal(await handshake(base), 'refused')
    assert.equal((await signIn('wrong')).status, 401)

    const granted = await signIn('k3y')
    assert.equal(granted.status, 303)
    const cookie = granted.headers.getSetCookie()[0].split(';')[0]

    assert.match(await (await fetch(page, { headers: { cookie } })).text(), /name="build"/)
    assert.equal(await handshake(base, { headers: { cookie } }), 'opened')
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})

test('/login is a 404 when there is no key, and must not reach the compare', async () => {
  const store = await storeFor([])
  const { supervisor, page } = await start({ sessionDir: store.sessionDir })
  try {
    assert.equal((await fetch(`${page}/login?key=x`)).status, 404)
  } finally {
    await supervisor.close()
    await rm(store.root, { recursive: true, force: true })
  }
})
