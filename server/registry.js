// Live PTYs have their own stable IDs. Pi's conversation ID is only the
// initial transcript to open; /new and /resume can change it in the same PTY.
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SCROLLBACK } from './protocol.js'

const KILL_GRACE_MS = 2_000
// How many sessions may run at once. The one place the pool size is decided.
const CAP = 10
const SESSION_EXTENSION = fileURLToPath(new URL('../pi-extensions/afield-session.ts', import.meta.url))

export class Registry {
  #children = new Map() // processId -> child
  #cliPath
  #pi
  #shell
  #socketDir
  #cap
  #scrollback
  #count = 0
  // Every process ID this registry hands out starts with this, so it can tell
  // its own from those of an earlier run of the server.
  #boot = randomUUID().slice(0, 8)

  /** A session is one of two kinds. `pi` is `{ command, args }`, the pi to run:
   *  it owns every conversation. `shell` is the path of a login shell, a plain
   *  terminal with no conversation. Either may be absent, and that kind is
   *  then not offered. */
  constructor({ cliPath, pi, shell, socketDir, cap = CAP, scrollback = DEFAULT_SCROLLBACK }) {
    this.#cliPath = cliPath
    this.#pi = pi
    this.#shell = shell
    this.#socketDir = socketDir
    this.#cap = cap
    this.#scrollback = scrollback
  }

  /** How many sessions may run at once. */
  get cap() { return this.#cap }

  /** The kinds of session a start may ask for. */
  get kinds() { return [...(this.#pi ? ['pi'] : []), ...(this.#shell ? ['shell'] : [])] }

  child(processId) { return this.#children.get(processId) }

  /** Whether this registry handed out the ID, running or long since ended. */
  startedHere(processId) { return processId.startsWith(`${this.#boot}-`) }

  /** The conversation this PTY currently has open. */
  current(child) {
    return JSON.parse(readFileSync(child.identityPath, 'utf8'))
  }

  owner(sessionId, cwd) {
    return [...this.#children.values()].find(child => {
      const current = this.current(child)
      return current.id === sessionId && current.cwd === cwd
    })
  }

  watch(processId, fn) {
    const child = this.child(processId)
    if (!child) { fn('terminal exited'); return () => {} }
    child.sockets.push(fn)
    return () => {
      const at = child.sockets.indexOf(fn)
      if (at === -1) return
      child.sockets.splice(at, 1)
      child.seenAt = Date.now()
    }
  }

  running() {
    return [...this.#children.values()].sort((a, b) => a.joinedAt - b.joinedAt)
  }

  /** Join a current conversation if it is live, otherwise start another PTY.
   *  Null when the cap is already reached: ending something is the user's
   *  call, made from the pick list, never this registry's. */
  async ensure(sessionId, cwd) {
    const existing = this.owner(sessionId, cwd)
    if (existing) {
      existing.joinedAt = Date.now()
      return existing
    }
    return this.start(sessionId, cwd)
  }

  /** A shell's `sessionId` names no conversation; it only keeps the session
   *  apart from every other, so nothing downstream needs telling the kinds apart. */
  async start(sessionId, cwd, { kind = 'pi' } = {}) {
    if (!this.kinds.includes(kind)) throw new Error(`no ${kind} sessions here`)
    if (this.running().length >= this.#cap) return null
    const n = ++this.#count
    const processId = `${this.#boot}-${n}`
    // Short, unique names within this supervisor's private directory. Neither
    // transport nor runtime identity is derived from a Pi conversation ID.
    const socketPath = join(this.#socketDir, `afield-${n}.sock`)
    const identityPath = join(this.#socketDir, `afield-${n}.identity`)
    writeFileSync(identityPath, JSON.stringify({ id: sessionId, cwd, at: Date.now() }))
    const [command, ...runtimeArgs] = kind === 'pi'
      ? [this.#pi.command, ...this.#pi.args, '-e', SESSION_EXTENSION, '--session-id', sessionId]
      : [this.#shell, '-l']
    let proc
    try {
      proc = fork(this.#cliPath, [
        '--internal-socket', socketPath, '--internal-cwd', cwd,
        '--scrollback', String(this.#scrollback), '--', command, ...runtimeArgs,
      ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, AFIELD_IDENTITY: identityPath, AFIELD_PROCESS_ID: processId } })
    } catch (err) {
      // spawn() itself failed -- no process, no exit to clean up after -- and
      // the identity file written above would be the one thing left claiming
      // this session exists. It is thrown on to the caller, which says it in
      // as many words rather than answering as if the request were at fault.
      rmSync(identityPath, { force: true })
      throw err
    }
    const joinedAt = Date.now()
    const child = { processId, sessionId, kind, proc, socketPath, identityPath, joinedAt, startedAt: joinedAt, seenAt: joinedAt, working: false, stoppedAt: 0, sockets: [] }
    this.#children.set(processId, child)
    let settled = false
    let resolveGone
    child.gone = new Promise(resolve => { resolveGone = resolve })
    // 'error' and 'exit' can both arrive for one child, and the rest of the
    // supervisor reads this map as "which PTYs exist": settling twice would
    // drop an entry (and its identity file) out from under a live child.
    const settle = () => {
      if (settled) return
      settled = true
      if (this.child(processId) === child) this.#children.delete(processId)
      for (const fn of child.sockets.splice(0)) fn(child.endReason ?? `${kind} exited`)
      // The files go before `gone` resolves: a stale identity file still in
      // the directory is one the next /resume would read as a live owner.
      Promise.all([rm(socketPath, { force: true }), rm(identityPath, { force: true }), rm(`${identityPath}.tmp`, { force: true })])
        .catch(err => console.error(`server: could not clean up terminal ${processId}`, err))
        .finally(resolveGone)
    }
    proc.on('exit', settle)
    // The child says when its PTY last moved. At zero viewers it is the only
    // sign that somebody is still working through this session. It also says
    // when its program starts and stops working, and stopping is what makes it
    // unread.
    proc.on('message', msg => {
      if (msg.afield === 'activity') child.lastOutputAt = msg.at
      if (msg.afield === 'working') {
        child.working = msg.working
        if (!msg.working) child.stoppedAt = msg.stoppedAt
      }
    })
    proc.on('error', err => {
      // No pid means the fork itself failed and there is no exit to come.
      // Anything else is a live child reporting a signal or IPC problem, which
      // is not a reason to forget that it exists.
      if (proc.pid) return void console.error(`server: terminal ${processId} reported an error`, err)
      console.error(`server: terminal ${processId} could not start`, err)
      settle()
    })
    return child
  }

  async end(processId, reason = 'ended by a terminal') {
    const child = this.child(processId)
    if (!child) return
    child.endReason = reason
    child.proc.kill('SIGTERM')
    const escalate = setTimeout(() => child.proc.kill('SIGKILL'), KILL_GRACE_MS)
    escalate.unref()
    await child.gone
    clearTimeout(escalate)
  }

  async endAll() {
    await Promise.all(this.running().map(child => this.end(child.processId, 'server stopped')))
  }
}
