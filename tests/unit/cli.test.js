// server/cli.js's own option parsing: flags after `--` belong to the program,
// and a value that would refuse every start is a typo rather than a setting.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const cli = fileURLToPath(new URL('../../server/cli.js', import.meta.url))
// Where every run here keeps its key, rather than the real config folder.
const config = await mkdtemp(join(tmpdir(), 'afield-cli-'))
after(() => rm(config, { recursive: true, force: true }))

// Stopped once the output matches `waitFor`; otherwise left to exit on its own.
const run = (args, { waitFor, env } = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [cli, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XDG_CONFIG_HOME: config, ...env } })
  let output = ''
  child.stdout.on('data', d => { output += d; if (waitFor?.test(output)) child.kill() })
  child.stderr.on('data', d => { output += d })
  child.on('close', code => resolve({ code, output }))
})

test('the program\'s own flags after -- are not the server\'s', async () => {
  const { code, output } = await run(['--port', '0', '--', 'sleep', '30', '--cap', '0'], { waitFor: /listening/ })
  assert.match(output, /listening/)
  assert.equal(code, 0)
})

test('serve makes a key and prints it, with the link that signs in with it', async () => {
  const { output } = await run(['--port', '0', '--', 'true'], { waitFor: /login\?key=\S+\n/ })
  const key = (await readFile(join(config, 'afield', 'key'), 'utf8')).trim()
  assert.match(output, new RegExp(`sign-in key: ${key}\n`))
  assert.match(output, new RegExp(`http://127\\.0\\.0\\.1:\\d+/login\\?key=${key}\n`))
})

test('--no-sign-in makes no key', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'afield-cli-'))
  try {
    const { output } = await run(['--port', '0', '--no-sign-in', '--', 'true'],
      { waitFor: /listening/, env: { XDG_CONFIG_HOME: empty } })
    assert.match(output, /listening/)
    assert.ok(!existsSync(join(empty, 'afield', 'key')))
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

test('a scrollback that is not a whole number is refused', async () => {
  const { code, output } = await run(['--scrollback', 'lots', '--', 'true'])
  assert.equal(code, 2)
  assert.match(output, /--scrollback/)
})

test('--no-pi serves terminals alone, and takes no pi command', async () => {
  const served = await run(['--port', '0', '--no-pi'], { waitFor: /listening/, env: { SHELL: '/bin/sh' } })
  assert.match(served.output, /listening/)
  const refused = await run(['--port', '0', '--no-pi', '--', 'pi'])
  assert.equal(refused.code, 2)
  assert.match(refused.output, /usage/)
})

test('--no-pi with no $SHELL is refused, since nothing would be left to run', async () => {
  const { code, output } = await run(['--port', '0', '--no-pi'], { env: { SHELL: '' } })
  assert.equal(code, 2)
  assert.match(output, /no \$SHELL/)
})

test('a cap given no value is refused', async () => {
  const { code, output } = await run(['--cap', '--', 'true'])
  assert.equal(code, 2)
  assert.match(output, /--cap/)
})
