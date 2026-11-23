// One live terminal: it owns a PTY and the program inside it.
//
// Nothing here may discard the unwritten tail of a read when a viewer's socket
// fills: that is where corrupt escape sequences come from.
//
// One instance serves exactly one program, in one folder, for its whole life
// — no switching. Running several sessions concurrently, and picking between
// them, is `server/supervisor.js`'s job: it spawns one of these per PTY
// (over a Unix socket, see `socketPath` below) and keeps it running in the
// background, so this file only ever has to think about "one PTY, N viewers,
// one screen".
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { openFooter } from './footer.js'
import { watchIdentity } from './identity.js'
import { placeNames } from './places.js'
import { Session } from './session.js'
import { Viewer } from './viewer.js'
import { Mirror } from './mirror.js'
import { INPUT, RESIZE, PROCESS, DEFAULT_SCROLLBACK, decodeHandshake, decodeSize, decodeFooter } from './protocol.js'

// Cloudflare drops idle sockets and the phone sleeps, so the socket has to be
// spoken to even when pi is silent. ttyd did this and it is why `up` survived a
// quiet evening.
const PING_MS = 30_000
// A resize costs pi a full transcript re-render, so viewers that flap their size
// are made to settle before anyone pays for it.
const RESIZE_COALESCE_MS = 100
// Generous for a paste, far short of what it takes to matter. Without it a
// viewer could hand the PTY a hundred megabytes in one frame.
const MAX_FRAME = 1024 * 1024
// How often the PTY's movement is told to the supervisor at most. Ending idle
// sessions is what it is for, so a word a second is all that needs.
const ACTIVITY_MS = 1_000
// How long the program has to have stopped working before the supervisor is
// told. pi-subagents takes 300ms and more to start the turn that follows a
// finished subagent, pi says done and working a few ms apart around a settled
// run, and its status and the extension's subagent poll arrive by different
// paths: none of those is the session stopping.
const STOP_HOLD_MS = 1_500
// Where the status strip's socket goes, for a server that was not told. A Unix
// socket path is capped at 104 bytes on macOS and the temp directory is nearly
// half of that, so the name is a short one -- and a random one, since a name a
// local user can guess is a name one can squat on, and these reports would then
// go to the squatter.
const footerSocketPath = () => join(tmpdir(), `afield-${randomUUID().slice(0, 8)}-footer.sock`)

/**
 * `scrollback` is how much history a reconnecting viewer gets back. pi does not
 * page its own transcript, so this is the only way to read back through a
 * conversation on a phone — roughly 75 bytes a line, so 10,000 lines is about
 * 750 KB per connect and per resize, against a pi transcript re-render that
 * starts at 12 KB and grows with every turn.
 *
 * The page carries the same number to the browser client, whose VT core keeps
 * that many lines and silently drops the rest.
 */

export function createTerminalServer({ socketPath, command, args = [], cwd = process.cwd(), scrollback = DEFAULT_SCROLLBACK, footerSocket = footerSocketPath(), onExit }) {
  // A program named by path means that program, not whatever happens to sit at
  // the same relative path in the session's own folder. A bare name is a PATH
  // lookup and is already independent of the cwd. Resolved against this
  // process's own directory, which for a supervisor-spawned child is the
  // directory the supervisor itself was launched from.
  const program = command.includes('/') ? resolve(process.cwd(), command) : command
  const viewers = new Set()

  // The supervisor is told over IPC, which a background child has and a
  // foreground server does not. A channel that has closed is a supervisor that
  // is gone, which is no reason to take the PTY down with it.
  const tell = msg => { if (process.connected) process.send(msg) }

  // Whether the program is working, for the tab markers: pi's own status (OSC
  // 7501, read by the mirror) says working, or background subagents are
  // running and pi is not waiting on the user. A program that reports neither
  // never works. Starting is told at once; stopping only once it has held, and
  // with the time it began, so a viewer who saw it stop and left during the
  // hold has still seen it. A dialog opening on an idle pi is a stop of its
  // own: either way the program is waiting on the user.
  let programState = null
  let subagents = false
  const current = () =>
    programState === 'working' || (subagents && programState !== 'blocked') ? 'working'
      : programState === 'blocked' ? 'blocked' : 'resting'
  // What the supervisor was last told this program is doing.
  let told = 'resting'
  let stopTimer = null
  const settleWorking = () => {
    if (current() === 'working') {
      clearTimeout(stopTimer)
      stopTimer = null
      if (told !== 'working') tell({ afield: 'working', working: true })
      told = 'working'
    } else if (current() !== told && !stopTimer) {
      const stoppedAt = Date.now()
      stopTimer = setTimeout(() => {
        stopTimer = null
        const now = current()
        // A dialog closing on an idle pi is nothing to come back to.
        if (told === 'working' || (now === 'blocked' && told !== 'blocked')) {
          tell({ afield: 'working', working: false, stoppedAt })
        }
        told = now
      }, STOP_HOLD_MS)
      stopTimer.unref()
    }
  }

  // The status strip's channel, up before the program is: the extension reports
  // the model and thinking level of whatever this PTY runs, and the last report
  // is what a viewer joining mid-session is given after its screen. Whether
  // subagents are running is the tab markers' business, not the strip's.
  let lastFooter = null
  const stopFooter = openFooter(footerSocket, text => {
    const decoded = decodeFooter(text)
    if (!decoded) return
    const { subagents: running, ...state } = decoded
    subagents = running
    settleWorking()
    if (JSON.stringify(state) === JSON.stringify(lastFooter)) return
    lastFooter = state
    for (const viewer of viewers) viewer.footer(state)
  })
  // Set for a background child: the supervisor seeds it before forking and the
  // afield-session extension rewrites it as pi switches conversations. The
  // program may not be pi at all, so this is the only thing that knows what
  // conversation a viewer was admitted to.
  const identityPath = process.env.AFIELD_IDENTITY

  // The program, its screen, and the folder it is in. Set once, when listening
  // starts, and never replaced.
  let active = null

  // Non-null while a snapshot is being taken. The mirror stops consuming for
  // that moment so the screen it serializes is exactly the screen these bytes
  // come after — see admit().
  let held = null

  const title = `${basename(program)} — ${cwd}`

  /**
   * The place this PTY is in, as one frame. The child is the only sender: it
   * owns the identity file, so a relay never has to guess. `name` and `path`
   * come from the same formatter a menu row uses.
   */
  const processFrame = state => JSON.stringify({
    ...state,
    processId: process.env.AFIELD_PROCESS_ID,
    ...placeNames(state.cwd),
  })

  /** Start the program and make it the session. Called exactly once. */
  const start = () => {
    // PI_PROGRAM_STATUS: pi otherwise reports its status only to a terminal
    // that answers its query, and nothing reliably answers for this PTY --
    // there may be no viewer at all when pi starts.
    const env = { ...process.env, AFIELD_FOOTER: footerSocket, PI_PROGRAM_STATUS: '1' }
    const session = new Session({ command: program, args, cwd, env })
    const onStatus = state => { programState = state; settleWorking() }
    const unit = { session, mirror: new Mirror({ ...session.size, scrollback, onStatus }) }

    unit.stopIdentity = identityPath && watchIdentity(identityPath, text => {
      const frame = processFrame(JSON.parse(text))
      for (const viewer of viewers) viewer.send(PROCESS, frame)
    })

    /**
     * A resize re-sends the screen rather than letting viewers reflow it.
     *
     * The client's VT core and the mirror are separate implementations and
     * need not rewrap history the same way, so a viewer that reflows its own
     * history can end up with something the mirror disagrees with — and
     * different again from what the next viewer to connect is given. The
     * mirror is the only thing allowed to reflow: everyone else is handed the
     * result.
     */
    session.onResize = size => {
      unit.mirror.resize(size.cols, size.rows)
      for (const viewer of viewers) if (viewer.queue === null) {
        if (viewer.kind === 'attach') {
          // A real terminal receives pi's redraw through the PTY. Sending it a
          // fresh snapshot would clear its scrollback again.
          viewer.sendSize(size)
          continue
        }
        // Same unhandled-rejection guard as admit(): a throw while serializing
        // the snapshot after a resize must not take the server (and the pi it
        // owns) down with it. The viewer just loses the refresh.
        sendScreen(viewer).catch(err => {
          console.error('server: could not re-send the screen after a resize', err)
          viewer.close()
        })
      }
    }

    let announcedActivity = 0
    session.onData = data => {
      // With no viewer attached, PTY output reports session activity.
      const now = Date.now()
      if (now - announcedActivity >= ACTIVITY_MS) {
        announcedActivity = now
        tell({ afield: 'activity', at: now })
      }
      // Viewers first: the mirror is a convenience, and a failure in it must not
      // cost anyone bytes it was about to be sent.
      for (const viewer of viewers) {
        if (viewer.queue) viewer.queue.push(data)
        else if (viewer.queue === null && !viewer.output(data)) viewers.delete(viewer)
      }
      if (held) held.push(data)
      else unit.mirror.write(data)
    }

    session.onExit = status => {
      unit.stopIdentity?.()
      for (const viewer of viewers) viewer.close(1000, 'session ended')
      onExit?.(status)
    }

    active = unit
  }

  /**
   * Give a viewer the screen, then everything that happened while we took it.
   *
   * The split has to be exact. Draining alone is not enough: the parser is
   * asynchronous, so bytes written behind the drain marker are parsed after the
   * snapshot is serialized and would be in neither the screen nor the queue.
   * Holding them out of the mirror instead makes the boundary a real one.
   *
   * Admissions are serialized, since two at once would fight over what is held.
   */
  let admitting = Promise.resolve()
  const sendScreen = viewer => {
    // `catch` before `then`, or one failure poisons the chain and every viewer
    // after it is refused a screen for the life of the process — which, since
    // the server is the session, means until pi is killed.
    admitting = admitting.catch(() => {}).then(async () => {
      if (!viewer.open) return
      const unit = active

      held = []
      viewer.queue = []
      try {
        await unit.mirror.drain()
        const snapshot = Buffer.from(unit.mirror.snapshot())

        // Size before screen: the snapshot is drawn for the PTY's grid, so a
        // viewer that asked for a different one has to be rendering at this
        // size before it arrives.
        viewer.sendSize(unit.session.size)
        // Screen, then the bytes the screen could not contain yet, then what
        // arrived while it was being taken.
        if (viewer.output(snapshot)) {
          const rest = unit.mirror.pending.length ? [Buffer.from(unit.mirror.pending), ...viewer.queue] : viewer.queue
          for (const chunk of rest) if (!viewer.output(chunk)) break
        }
      } finally {
        // Whatever happened to this viewer, the mirror has to be fed again or
        // every screen after this one is stale.
        viewer.queue = null
        for (const chunk of held) unit.mirror.write(chunk)
        held = null
      }
    })
    return admitting
  }

  const admit = viewer => {
    // Before the screen: a viewer knows which place it landed on by the frame
    // that says so, and the frame cannot be second if the screen is to be
    // committed to it. Reading the file rather than a cached copy, since
    // admission can beat the watcher's first poll.
    if (identityPath) viewer.send(PROCESS, processFrame(JSON.parse(readFileSync(identityPath, 'utf8'))))
    active.session.add(viewer)
    viewer.title(title)
    // The latest strip state after the screen: a viewer that connects mid-session
    // gets the current stats, not the stale screen's.
    return sendScreen(viewer).then(() => {
      if (viewer.open && lastFooter !== null) viewer.footer(lastFooter)
    })
  }

  let fitTimer = null
  const scheduleFit = () => {
    if (fitTimer) return
    fitTimer = setTimeout(() => { fitTimer = null; active?.session.fit() }, RESIZE_COALESCE_MS)
    fitTimer.unref()
  }

  // The supervisor serves the page and the login; this only takes its sockets.
  const http = createServer()

  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: MAX_FRAME,
    handleProtocols: () => 'tty',
  })

  wss.on('error', err => {
    console.error(`server: cannot listen on ${socketPath}: ${err.message}`)
    onExit?.({ exitCode: 1, signal: 0 })
  })

  wss.on('connection', ws => {
    const viewer = new Viewer(ws)
    viewers.add(viewer)
    ws.on('pong', () => { viewer.alive = true })

    ws.on('message', data => {
      const buf = Buffer.from(data)
      if (!viewer.started) {
        const hello = decodeHandshake(buf)
        if (!hello) return void viewer.close(1002, 'bad handshake')
        viewer.started = true
        viewer.kind = hello.client === 'attach' ? 'attach' : 'browser'
        viewer.size = { cols: hello.cols, rows: hello.rows }
        admit(viewer).catch(err => {
          console.error('server: could not admit a viewer', err)
          viewer.close(1011, 'could not send the screen')
        })
        return
      }
      if (buf.length === 0) return
      switch (buf[0]) {
        case INPUT:
          active.session.write(buf.subarray(1))
          break
        case RESIZE: {
          const size = decodeSize(buf.subarray(1))
          if (size) {
            viewer.size = size
            scheduleFit()
          }
          break
        }
        default:
          break
      }
    })

    const drop = () => {
      viewers.delete(viewer)
      active?.session.remove(viewer)
    }
    ws.on('close', drop)
    ws.on('error', drop)
  })

  const ping = setInterval(() => {
    for (const viewer of viewers) {
      if (!viewer.open) continue
      if (!viewer.alive) { viewer.ws.terminate(); continue }
      viewer.alive = false
      viewer.ws.ping()
    }
  }, PING_MS)
  ping.unref()

  // The program starts here rather than before listening: one that cannot be
  // served should never have been spawned, and a pi that starts only to be
  // killed leaves a session file behind for the folder list to offer.
  // The socket is reachable only by whatever can open that file -- never a
  // network port.
  http.listen(socketPath, start)

  return {
    http,
    async close() {
      clearInterval(ping)
      clearTimeout(fitTimer)
      clearTimeout(stopTimer)
      stopFooter()
      active?.stopIdentity?.()
      active?.session.kill()
      // Terminated, not closed: a close frame waits for one back, and a phone
      // asleep behind a dead tunnel does not answer for 30 seconds — which is
      // how long Ctrl-C would appear to hang, since an upgraded socket holds
      // http.close() open until it goes. Nobody is owed a handshake from a
      // server that is already gone.
      for (const viewer of viewers) viewer.ws.terminate()
      wss.close()
      await new Promise(res => http.close(res))
    },
  }
}
