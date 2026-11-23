// The server is the session, so a fault has nowhere to go: there is no second
// copy of pi and restarting means losing it. These are the paths where one
// viewer could take the rest down with it.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { WebSocket } from 'ws'
import { createTerminalServer } from '../../server/index.js'
import { Mirror } from '../../server/mirror.js'
import { until } from '../until.js'

// Short: a Unix socket path is capped at 104 bytes on macOS.
const sockets = await mkdtemp(pathJoin(tmpdir(), 'afield-'))
after(() => rm(sockets, { recursive: true, force: true }))
let served = 0

const start = async (command = 'tests/fixtures/fake-pi.js', args = [], options = {}) => {
  const socketPath = pathJoin(sockets, `${++served}.sock`)
  const server = createTerminalServer({ socketPath, command, args, ...options })
  await new Promise(r => server.http.on('listening', r))
  return { server, url: `ws+unix://${socketPath}:/ws` }
}

/** Connect, handshake, and report the first screen output. */
const join = (url, handshake = { columns: 50, rows: 20 }) => new Promise(resolve => {
  const ws = new WebSocket(url, ['tty'])
  let output = 0
  let settled = false
  let deadline
  const finish = result => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    resolve(result)
  }
  deadline = setTimeout(() => ws.terminate(), 3_000)
  // terminate() before the handshake completes emits an error; unhandled, it crashes the runner.
  ws.on('error', () => finish({ code: null, output }))
  ws.on('open', () => ws.send(JSON.stringify(handshake)))
  ws.on('message', d => {
    const buf = Buffer.from(d)
    if (buf[0] !== 0x30) return
    output += buf.length - 1
    ws.close()
    finish({ code: null, output })
  })
  ws.on('close', code => finish({ code, output }))
})

test('a failed admission costs one viewer, not every viewer after it', async () => {
  const { server, url } = await start()
  const real = Mirror.prototype.snapshot
  let fail = true
  Mirror.prototype.snapshot = function (...a) {
    if (!fail) return real.apply(this, a)
    fail = false
    throw new Error('rigged')
  }
  try {
    const broken = await join(url)
    assert.equal(broken.code, 1011, 'the viewer whose snapshot failed is closed')
    assert.equal(broken.output, 0)

    // Admissions are serialized through one promise, so a rejection left
    // unhandled would skip the body for every viewer that followed.
    const after = await join(url)
    assert.equal(after.code, null, 'the next viewer stays connected')
    assert.ok(after.output > 0, 'the next viewer gets a screen')
  } finally {
    Mirror.prototype.snapshot = real
    await server.close()
  }
})

test('a nonsense handshake closes that socket and nothing else', async () => {
  const { server, url } = await start()
  try {
    const bad = await join(url, { columns: 'wide', rows: null })
    assert.equal(bad.code, 1002)

    const good = await join(url)
    assert.ok(good.output > 0, 'a later viewer is unaffected')
  } finally { await server.close() }
})

test('a viewer is told which conversation it landed on before the screen', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'afield-identity-'))
  const identityPath = pathJoin(dir, 'afield-1.identity')
  const cwd = pathJoin(dir, 'project')
  await writeFile(identityPath, JSON.stringify({ id: 'conversation', cwd, at: 7 }))
  const saved = { identity: process.env.AFIELD_IDENTITY, process: process.env.AFIELD_PROCESS_ID }
  process.env.AFIELD_IDENTITY = identityPath
  process.env.AFIELD_PROCESS_ID = 'process-1'
  const { server, url } = await start()
  const frames = []
  const ws = new WebSocket(url, ['tty'])
  try {
    await new Promise((done, fail) => { ws.once('open', done); ws.once('error', fail) })
    ws.on('message', d => frames.push(Buffer.from(d)))
    ws.send(JSON.stringify({ columns: 50, rows: 20 }))
    for (let i = 0; i < 100 && !frames.some(f => [0x30, 0x33].includes(f[0])); i++) await settle(20)

    // The child is the only sender, and the place is the first frame that
    // draws: after it the screen is already being committed to a conversation.
    const drew = frames.filter(f => [0x30, 0x33, 0x35].includes(f[0]))
    assert.equal(drew[0]?.[0], 0x35)
    assert.deepEqual(JSON.parse(drew[0].subarray(1).toString()), {
      id: 'conversation', cwd, at: 7, processId: 'process-1', name: 'project', path: cwd,
    })
  } finally {
    ws.close()
    await server.close()
    if (saved.identity === undefined) delete process.env.AFIELD_IDENTITY
    else process.env.AFIELD_IDENTITY = saved.identity
    if (saved.process === undefined) delete process.env.AFIELD_PROCESS_ID
    else process.env.AFIELD_PROCESS_ID = saved.process
    await rm(dir, { recursive: true, force: true })
  }
})

test('shutting down does not wait on a viewer that has stopped answering', async () => {
  const { server, url } = await start()
  const ws = new WebSocket(url, ['tty'])
  await new Promise(resolve => ws.on('open', resolve))
  ws.send(JSON.stringify({ columns: 50, rows: 20 }))
  await new Promise(resolve => setTimeout(resolve, 300))

  // A phone asleep behind a dead tunnel: the socket is up and never answers.
  // A close frame would wait 30s for a reply that is not coming, and an
  // upgraded socket holds http.close() open until it goes — so Ctrl-C hangs.
  ws._socket.pause()

  const began = Date.now()
  await server.close()
  assert.ok(Date.now() - began < 5_000, `close() took ${Date.now() - began}ms`)
})

test('a resize arriving after the program exits does not take the server down', async () => {
  const { Session } = await import('../../server/session.js')
  const session = new Session({ command: 'sh', args: ['-c', 'exit 0'], cols: 80, rows: 24 })
  session.viewers.add({ size: { cols: 40, rows: 12 } })
  await new Promise(resolve => { session.onExit = resolve })
  await new Promise(resolve => setTimeout(resolve, 150))

  // Viewers outlive the program by however long their sockets take to close, so
  // a coalesced resize can land on a closed PTY — which throws EBADF from a
  // timer, where nothing can catch it and the process is the session.
  assert.doesNotThrow(() => session.fit())
})

/** Connect, ask for a size, and collect every grid the server reports. */
const viewer = (url, columns, rows) => {
  const seen = []
  const ws = new WebSocket(url, ['tty'])
  ws.on('open', () => ws.send(JSON.stringify({ columns, rows })))
  ws.on('message', d => {
    const buf = Buffer.from(d)
    if (buf[0] === 0x33) seen.push(JSON.parse(buf.subarray(1)))
  })
  return { seen, close: () => ws.close() }
}

const settle = (ms = 500) => new Promise(resolve => setTimeout(resolve, ms))

/** Report the status strip, as the extension does: one connection, one object. */
const report = (footerSocket, state) => new Promise((resolve, reject) => {
  const sock = connect(footerSocket)
  sock.on('error', reject)
  sock.on('close', resolve)
  sock.end(`${JSON.stringify(state)}\n`)
})

test('the status strip: relayed as reported, replayed to latecomers', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'afield-footer-'))
  const footerSocket = pathJoin(dir, 'footer.sock')
  const { server, url } = await start('sh', ['-c', 'sleep 60'], { footerSocket })
  const frames = []
  const stripViewer = () => {
    const ws = new WebSocket(url, ['tty'])
    let ready = false
    ws.on('open', () => ws.send(JSON.stringify({ columns: 50, rows: 20 })))
    ws.on('message', d => {
      const buf = Buffer.from(d)
      if (buf[0] === 0x30) ready = true
      if (buf[0] === 0x34) frames.push(buf.subarray(1).toString())
    })
    return { ready: () => ready, close: () => ws.close() }
  }
  try {
    const first = stripViewer()
    await until(first.ready, 'the first viewer admission')
    assert.equal(frames.length, 0, 'nothing until the program reports one')

    const initial = { provider: 'a', id: 'one', thinking: null }
    await report(footerSocket, initial)
    await until(() => frames.length === 1, 'the first status report')
    assert.deepEqual(frames, [JSON.stringify(initial)])

    const changed = { provider: 'a', id: 'one', thinking: 'max' }
    await report(footerSocket, changed)
    await until(() => frames.length === 2, 'the changed status report')
    assert.deepEqual(frames, [JSON.stringify(initial), JSON.stringify(changed)])

    // A report that is not a state is nothing a strip can draw.
    await report(footerSocket, { thinking: 'max' })
    const afterInvalid = { provider: 'barrier', id: 'barrier', thinking: null }
    await report(footerSocket, afterInvalid)
    await until(() => frames.length === 3, 'the status report after the invalid one')
    assert.deepEqual(frames, [JSON.stringify(initial), JSON.stringify(changed), JSON.stringify(afterInvalid)])

    // The report is one line of state, not a stream to buffer.
    await report(footerSocket, { provider: 'x'.repeat(4096), id: 'one', thinking: null })
    const afterLarge = { provider: 'barrier-2', id: 'barrier-2', thinking: null }
    await report(footerSocket, afterLarge)
    await until(() => frames.length === 4, 'the status report after the oversized one')
    assert.deepEqual(frames, [
      JSON.stringify(initial), JSON.stringify(changed), JSON.stringify(afterInvalid), JSON.stringify(afterLarge),
    ])

    // A viewer arriving after the fact gets the latest state after its screen.
    const beforeLate = frames.length
    const late = stripViewer()
    await until(() => frames.length === beforeLate + 1, 'the latest status replay')
    assert.equal(frames.at(-1), JSON.stringify(afterLarge))

    // No model is a state of its own, relayed like any other: a strip showing
    // the last one clears on it.
    const empty = { provider: '', id: '', thinking: null }
    const beforeEmpty = frames.length
    await report(footerSocket, empty)
    await until(() => frames.length === beforeEmpty + 2, 'the empty state reaching both viewers')
    assert.deepEqual(frames.slice(beforeEmpty), [JSON.stringify(empty), JSON.stringify(empty)])
    first.close()
    late.close()
  } finally {
    await server.close()
    await assert.rejects(stat(footerSocket), { code: 'ENOENT' })
    await rm(dir, { recursive: true, force: true })
  }
})

test('attach avoids a second snapshot reset on a grid change', async () => {
  const { server, url } = await start('sh', ['-c', 'printf ready; sleep 30'])
  const output = []
  const sizes = []
  const attach = new WebSocket(url, ['tty'])
  attach.on('open', () => attach.send(JSON.stringify({
    client: 'attach', columns: 80, rows: 24,
  })))
  attach.on('message', d => {
    const buf = Buffer.from(d)
    if (buf[0] === 0x30) output.push(buf.subarray(1))
    if (buf[0] === 0x33) sizes.push(JSON.parse(buf.subarray(1)))
  })
  let narrow
  try {
    await settle()
    assert.ok(output[0]?.toString().startsWith('\x1bc\x1b[3J'),
      'attach gets the normal replacement snapshot on its initial admission')

    narrow = viewer(url, 40, 12)
    await settle()
    assert.deepEqual(sizes.at(-1), { columns: 40, rows: 12 })
    assert.equal(output.slice(1).some(bytes => bytes.includes(Buffer.from('\x1bc'))), false,
      'a grid change does not clear attach scrollback with RIS')
  } finally {
    narrow?.close()
    attach.close()
    await server.close()
  }
})

test('the narrowest viewer sets the grid, and leaving hands it back', async () => {
  const { server, url } = await start()
  const wide = viewer(url, 100, 30)
  let narrow
  try {
    await settle()
    assert.deepEqual(wide.seen.at(-1), { columns: 100, rows: 30 }, 'alone, a viewer gets what it asked for')

    narrow = viewer(url, 40, 12)
    await settle()
    assert.deepEqual(narrow.seen.at(-1), { columns: 40, rows: 12 })
    assert.deepEqual(wide.seen.at(-1), { columns: 40, rows: 12 }, 'the wide viewer is told it lost')

    narrow.close()
    await settle()
    assert.deepEqual(wide.seen.at(-1), { columns: 100, rows: 30 }, 'and told again when it wins it back')
  } finally {
    narrow?.close()
    wide.close()
    await server.close()
  }
})

/** Render everything a viewer is sent, the way the phone's core would. */
const rendering = async url => {
  const { WasmBridge } = await import('@wterm/core')
  const core = await WasmBridge.load()
  core.init(80, 24)
  const ws = new WebSocket(url, ['tty'])
  ws.on('open', () => ws.send(JSON.stringify({ columns: 80, rows: 24 })))
  ws.on('message', d => {
    const buf = Buffer.from(d)
    if (buf[0] === 0x30) core.writeRaw(buf.subarray(1))
    if (buf[0] === 0x33) {
      const { columns, rows } = JSON.parse(buf.subarray(1))
      if (columns !== core.getCols() || rows !== core.getRows()) core.resize(columns, rows)
    }
  })
  // Oldest first: wterm numbers saved rows newest to oldest.
  const history = () => Array.from({ length: core.getScrollbackCount() }, (_, i) =>
    Array.from({ length: core.getCols() }, (_, x) =>
      String.fromCodePoint(core.getScrollbackCell(i, x).char || 32)).join('').trimEnd()).reverse()
  return { history, close: () => ws.close() }
}

test('a resize leaves every viewer with the same history, whenever it joined', async () => {
  // Print a page of history and go quiet, so nothing redraws over the evidence.
  const lines = Array.from({ length: 60 }, (_, n) => `L${String(n).padStart(3, '0')}:${'x'.repeat(70)}`)
  const { server, url } = await start('sh', ['-c', `printf '%s\\n' ${lines.join(' ')}; sleep 30`])

  let narrow, early, late
  try {
    early = await rendering(url)
    await settle()

    // A narrower viewer takes the grid. A viewer left to reflow its own history
    // can diverge from one sent the mirror's screen.
    narrow = viewer(url, 50, 20)
    await settle()
    await settle()

    late = await rendering(url)

    // Poll rather than sample: both viewers are being served through the same
    // serialized queue, so agreement is what matters, not the instant it arrives.
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try {
        assert.deepEqual(early.history(), late.history())
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
    assert.deepEqual(early.history(), late.history(),
      'a viewer resized into the grid and one that arrived at it never agree')
  } finally {
    narrow?.close(); early?.close(); late?.close()
    await server.close()
  }
})

test('a full history of dense colour on a wide grid still reaches a joining viewer', async () => {
  // The heaviest a snapshot gets: every line of the default history at full
  // width with a colour change every four cells, as a diff or highlighted code
  // has. It goes out as one chunk, so the backlog limit has to hold all of it.
  // The program waits for a key so it prints at the grid the viewer asked for.
  const program = `process.stdin.once('data', () => {
    let line = ''
    for (let c = 0; c < 196; c += 4) line += '\\x1b[38;5;' + (16 + c) + 'mabcd'
    for (let i = 0; i < 10100; i++) process.stdout.write(line + '\\x1b[0m\\r\\n')
    process.stdout.write('ALL-PRINTED')
  })
  setInterval(() => {}, 1000)`
  const { server, url } = await start(process.execPath, ['-e', program])
  const handshake = JSON.stringify({ columns: 200, rows: 50 })
  let first, late
  try {
    let columns = 0, tail = ''
    first = new WebSocket(url, ['tty'])
    first.on('open', () => first.send(handshake))
    first.on('message', d => {
      const buf = Buffer.from(d)
      if (buf[0] === 0x33) columns = JSON.parse(buf.subarray(1)).columns
      if (buf[0] === 0x30) tail = (tail + buf.subarray(1).toString('latin1')).slice(-64)
    })
    await until(() => columns === 200, 'the 200-column grid')
    first.send(Buffer.from('0\r'))
    await until(() => tail.includes('ALL-PRINTED'), 'the program to finish printing', 30_000)

    let snapshot = 0, closed = null
    late = new WebSocket(url, ['tty'])
    late.on('open', () => late.send(handshake))
    late.on('close', code => { closed = code })
    late.on('message', d => { if (Buffer.from(d)[0] === 0x30) snapshot = Math.max(snapshot, d.length) })
    await until(() => snapshot > 0 || closed !== null, 'the snapshot or a refusal')
    assert.equal(closed, null, 'the joining viewer was cut loose instead of sent the screen')
    // The size is part of the assertion: a fixture that stopped being heavy
    // would pass without testing anything.
    assert.ok(snapshot > 5 * 1024 * 1024, `the snapshot was only ${snapshot} bytes`)
  } finally {
    first?.close(); late?.close()
    await server.close()
  }
})
