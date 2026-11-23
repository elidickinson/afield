// The real bin script: option parsing, the cwd it captures before cd'ing into
// the checkout, and the verb dispatch it execs. Bounded runs — these fail or
// refuse before anything attaches, so they need no pty.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const bin = fileURLToPath(new URL('../../afield', import.meta.url))

const run = (args, cwd, port = '1', env = {}, input) => new Promise(resolve => {
  const child = spawn('bash', [bin, ...args], {
    cwd,
    // Port 1 on loopback refuses fast: nothing listens there, which is the
    // no-server case `new` is meant to answer plainly.
    // No key file, so nothing here signs in or can make one.
    env: { ...process.env, AFIELD_PORT: port, XDG_CONFIG_HOME: '/nonexistent', ...env },
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  child.stdin?.end(input)
  let output = ''
  child.stdout.on('data', d => { output += d })
  child.stderr.on('data', d => { output += d })
  child.on('close', code => resolve({ code, output }))
})

test('unknown commands are reported instead of treated as sessions arguments', async () => {
  for (const args of [['unknown'], ['--port', '1', 'unknown'], ['--', 'unknown']]) {
    const { code, output } = await run(args)
    assert.equal(code, 2)
    assert.equal(output, 'afield: unknown command: unknown\n')
  }
})

test('resume is an alias for attach', async () => {
  for (const args of [['resume'], ['resume', 'project'], ['--port', '1', 'resume']]) {
    const { code, output } = await run(args)
    assert.equal(code, 2)
    assert.match(output, /attach: not a terminal/)
  }
  const { code, output } = await run(['resume', '-', 'extra'])
  assert.equal(code, 2)
  assert.equal(output, 'afield: attach - takes no session name\n')
})

test('explicit sessions still rejects arguments', async () => {
  const { code, output } = await run(['sessions', 'extra'])
  assert.equal(code, 2)
  assert.equal(output, 'afield: sessions takes no arguments\n')
})

test('bare afield lists sessions when a server answers, unless given an option only serve reads', async () => {
  const server = createServer((req, res) => res.end(JSON.stringify({ sessions: [] })))
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = String(server.address().port)
    assert.equal((await run([], undefined, port)).output, 'nothing is running\n')
    // With no $SHELL a --no-pi server refuses at once: proof it was asked to serve.
    assert.match((await run(['--no-pi'], undefined, port, { SHELL: '' })).output, /no \$SHELL/)
  } finally {
    server.close()
  }
})

test('new refuses with how to start the server when none answers', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'afield-bin-'))
  try {
    const { code, output } = await run(['new'], scratch)
    assert.equal(code, 0)
    assert.match(output, /server not started; run afield serve/)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('new attaches to the session it starts', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'afield-bin-'))
  let startedIn, kind
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/places') return res.end(JSON.stringify({ sessions: [] }))
    assert.equal(req.url, '/start')
    let body = ''
    for await (const chunk of req) body += chunk
    ;({ cwd: startedIn, kind } = JSON.parse(body))
    res.end(JSON.stringify({ id: 'fresh-id' }))
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const { code, output } = await run(['new', '--shell'], scratch, String(server.address().port))
    assert.equal(startedIn, await realpath(scratch))
    assert.equal(kind, 'shell')
    assert.equal(code, 2)
    assert.match(output, /attach: not a terminal/)
    assert.doesNotMatch(output, /TypeError/)
  } finally {
    server.close()
    await rm(scratch, { recursive: true, force: true })
  }
})

test('serve checks a pi given as a path, from the folder it was run in', async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'afield-bin-')))
  try {
    const { code, output } = await run(['serve', './missing'], scratch)
    assert.equal(code, 1)
    assert.equal(output, `afield: ${scratch}/./missing is not an executable file\n`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('serve --no-pi hands the server --no-pi and no command', async () => {
  // With no $SHELL the server refuses at once: proof it was told --no-pi and
  // given no pi, without anything left listening.
  const { code, output } = await run(['serve', '--no-pi'], undefined, '1', { SHELL: '' })
  assert.equal(code, 2)
  assert.match(output, /no \$SHELL/)
})

test('set-key saves the key typed, readable only by this user, and refuses an empty one', async () => {
  const config = await mkdtemp(join(tmpdir(), 'afield-bin-'))
  try {
    const key = join(config, 'afield', 'key')
    assert.match((await run(['set-key'], undefined, '1', { XDG_CONFIG_HOME: config }, ' - \n')).output, /cannot be empty/)
    const { code } = await run(['set-key'], undefined, '1', { XDG_CONFIG_HOME: config }, 'correct horse\n')
    assert.equal(code, 0)
    assert.equal(await readFile(key, 'utf8'), 'correct horse\n')
    assert.equal((await stat(key)).mode & 0o777, 0o600)
  } finally {
    await rm(config, { recursive: true, force: true })
  }
})

test('new takes no arguments', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'afield-bin-'))
  try {
    const { code, output } = await run(['new', 'extra'], scratch)
    assert.equal(code, 2)
    assert.match(output, /new takes no arguments/)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
