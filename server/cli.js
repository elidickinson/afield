// Command line for the server, so `afield serve` can start it the way it
// started ttyd.
//
// Two modes live here. The ordinary one launches the supervisor, which holds
// every live session in the background. `--internal-socket` is the other:
// server/registry.js re-invokes this same file with it to spawn one session's
// child: server/index.js, serving that one PTY on a Unix socket.
// Nothing outside the supervisor's own process tree is meant to pass it.
import { ensureKey } from './auth.js'
import { createTerminalServer } from './index.js'
import { createSupervisor } from './supervisor.js'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { isIP } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderUnicodeCompact } from 'uqr'

// Drawn light-on-dark, the colours renderUnicodeCompact assumes, and pinned
// there so the code still scans in a light terminal.
const qr = text => renderUnicodeCompact(text, { border: 2 }).split('\n')
  .map(line => `  \x1b[97;40m${line}\x1b[0m`).join('\n')

// Everything after `--` belongs to the program being run, so a flag of the
// program's own (pi has its own --theme, say) must never read as one of ours.
const argv = (() => {
  const i = process.argv.indexOf('--')
  return i === -1 ? process.argv : process.argv.slice(0, i)
})()
const arg = name => {
  const i = argv.indexOf(name)
  if (i === -1) return undefined
  const value = argv[i + 1]
  // The separator after a flag is not its value, and a flag last on the line
  // has none: either way the default would silently win.
  if (value === undefined || value === '--') {
    console.error(`${name} needs a value`)
    process.exit(2)
  }
  return value
}
const rest = () => {
  const i = process.argv.indexOf('--')
  return i === -1 ? [] : process.argv.slice(i + 1)
}

// A flag given no value, or a typo, would otherwise reach node-pty or xterm as
// NaN and fail somewhere far from the mistake.
const number = (name, fallback) => {
  const raw = arg(name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    console.error(`${name} needs a whole number, got ${JSON.stringify(raw)}`)
    process.exit(2)
  }
  return n
}

// A theme is a palette the client is built with; an unknown name would silently
// serve the default, which is a typo that looks like a broken flag.
const theme = arg('--theme') ?? 'dark'
if (!['dark', 'light'].includes(theme)) {
  console.error(`${theme} is not a theme (dark or light)`)
  process.exit(2)
}

// Lines of history the mirror keeps and the client is told to keep. Unset
// leaves the default to the server.
const scrollback = number('--scrollback', undefined)

// Where "new session" starts when the phone asks for one: here, unless this
// run was pointed somewhere else. Resolved to a real path now, so a typo is
// refused at startup rather than on the phone's first tap.
const newDir = arg('--new-dir')
if (newDir && !(existsSync(newDir) && statSync(newDir).isDirectory())) {
  console.error(`no such directory: ${newDir}`)
  process.exit(2)
}

const internalSocket = arg('--internal-socket')

/** A 0700 directory under the system temp dir, for this run's session sockets. */
const mkdirPrivate = () => mkdtemp(join(tmpdir(), 'afield-sock-'))

if (internalSocket) {
  const cwd = arg('--internal-cwd')
  const [command, ...args] = rest()
  const server = createTerminalServer({
    socketPath: internalSocket,
    cwd,
    scrollback,
    command,
    args,
    // A session this holds ending — pi exiting on its own — is the session
    // ending, same as it always was; the supervisor learns of it when this
    // process exits and its socket stops answering.
    onExit: ({ exitCode }) => server.close().then(() => process.exit(exitCode ?? 0)),
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close().then(() => process.exit(0)))
  }
  // The registry spawns this over fork(), which wires up an IPC channel for
  // nothing else but this: the channel closing is how a child notices the
  // supervisor is gone even when it never got the chance to ask nicely first
  // (a crash, or a signal aimed at the wrong pid) — the one case a plain
  // SIGTERM/SIGINT handler cannot cover, since nothing sent one.
  process.on('disconnect', () => server.close().then(() => process.exit(0)))
} else {
  // The command after `--` is the pi to run, unless --no-pi says there is none.
  const noPi = argv.includes('--no-pi')
  const [command, ...args] = rest()
  if (Boolean(command) === noPi) {
    console.error('usage: node server/cli.js --port N --bind ADDR --hostname NAME --theme NAME --cap N --scrollback N [--no-sign-in] (--no-pi | -- <pi command...>)')
    process.exit(2)
  }
  // Terminals run your login shell, the one a desktop terminal would.
  const shell = process.env.SHELL || undefined
  if (noPi && !shell) {
    console.error('--no-pi leaves only terminals, and there is no $SHELL for them to run')
    process.exit(2)
  }

  const bind = arg('--bind') ?? '127.0.0.1'
  const hostname = arg('--hostname')
  // Whoever reaches the port gets a shell, so every connection signs in unless
  // told not to.
  const key = argv.includes('--no-sign-in') ? undefined : ensureKey()

  const supervisor = createSupervisor({
    port: number('--port', 7681),
    cap: number('--cap', undefined),
    bind,
    hostname,
    theme,
    scrollback,
    newDir,
    key,
    pi: noPi ? undefined : { command, args },
    shell,
    cliPath: new URL(import.meta.url).pathname,
    // A fresh private directory per supervisor: session sockets must not land
    // in the shared tmpdir under a guessable name, where any local user could
    // squat on one and answer a join in our place.
    socketDir: await mkdirPrivate(),
    onListen: ({ port }) => {
      const address = isIP(bind) === 6 ? `[${bind}]` : bind
      console.log(`listening on http://${address}:${port}`)
      if (!key) return
      console.log(`sign-in key: ${key}`)
      // Only decides what to print: a loopback address is no use to a phone,
      // and a name in front of one is a proxy's, which serves https.
      const local = bind === 'localhost' || bind === '::1' || bind.startsWith('127.')
      // A wildcard address is not one a phone can open, so name the real ones.
      const bases = hostname ? [local ? `https://${hostname}` : `http://${hostname}:${port}`]
        : bind === '0.0.0.0' || bind === '::'
          ? Object.values(networkInterfaces()).flat()
            .filter(net => net?.family === 'IPv4' && !net.internal).map(net => `http://${net.address}:${port}`)
          : [`http://${address}:${port}`]
      const links = bases.map(base => `${base}/login?key=${encodeURIComponent(key)}`)
      if (links.length > 0 && (hostname || !local)) console.log(`\n${qr(links[0])}\n`)
      for (const link of links) console.log(`  ${link}`)
    },
    onExit: ({ exitCode }) => supervisor.close().then(() => process.exit(exitCode ?? 0)),
  })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => supervisor.close().then(() => process.exit(0)))
  }
}
