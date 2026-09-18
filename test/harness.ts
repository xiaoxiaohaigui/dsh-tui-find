/**
 * The shared scene harness: mounts a real FindScene against the real host
 * ui kit with fake stdin/stdout streams, exposing key sending, pointer
 * (mouse) injection, frame capture and close counting. Used by every
 * scene-level wiring test — preview-wiring.test.ts and menu-wiring.test.ts
 * speak the same harness so their frames are captured and stripped
 * identically.
 */
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import * as hostUi from '../node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ui.js'
import { resolveConfig } from '../src/config.js'
import type { ScannedSession } from '../src/core/scan.js'
import { FindScene } from '../src/scene.js'

// OSC52 clipboard delivery needs an SSH-looking terminal (see clipboard.ts);
// without it the copy status rows the tests assert on are suppressed.
process.env['SSH_CONNECTION'] ??= 'scene-harness'

export type Harness = {
  send(input: string): void
  /** Pointer move (no-button motion) at a 1-indexed terminal cell — the
   *  SGR form mode-1003 hover emits; drives onMouseEnter/onMouseLeave. */
  movePointer(col: number, row: number): void
  /** Left click (press + release) at a 1-indexed terminal cell. The host
   *  dispatches the DOM click on the RELEASE event. */
  clickAt(col: number, row: number): void
  /** Right click (press + release) at a 1-indexed terminal cell. The host
   *  dispatches the context menu on the PRESS event (DOM mousedown
   *  semantics, 0.10+ kits only). */
  rightClickAt(col: number, row: number): void
  all(): string
  latest(): string
  /** The cumulative stream with its ANSI intact — for the few assertions
   *  about STYLING (a dimmed border, a tinted span) that the stripped
   *  frames cannot carry. */
  raw(): string
  /** The last painted frame with its ANSI intact (the `latest()` anchor). */
  rawLatest(): string
  closed(): number
  /** Emits a real dimension change so the host renderer fully repaints. */
  resize(columns: number, rows: number): void
  dispose(): void
}

export function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

export function waitFor(ms = 100): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The SGR run that paints `glyph`, verbatim — the escapes immediately before
 *  it, skipping the padding cell the badge's own text carries. Style
 *  assertions need the RAW stream (`latest()` strips escapes), and taking the
 *  run rather than the whole frame keeps them honest about what is styled. */
export function glyphStyle(frame: string, glyph: string): string {
  const at = frame.lastIndexOf(glyph)
  if (at < 0) return ''
  return /((?:\u001b\[[0-9;]*m)+)[^\S\r\n]*$/.exec(frame.slice(0, at))?.[1] ?? ''
}

/** Whether an SGR run sets a background, at ANY palette depth: the 8/16-colour
 *  codes (40-47, 100-107) and the 256/truecolour `48;…` forms. Which one a
 *  theme produces follows the HOST generation (0.10.1 renders
 *  `userMessageBackgroundHover` as SGR 44, 0.10.2 as truecolor), so a test
 *  pinning one depth fails on the other for no real reason. `49` (default
 *  background) is a RESET, not a fill, and does not count. */
export function hasBackground(style: string): boolean {
  for (const match of style.matchAll(/\u001b\[([0-9;]*)m/g)) {
    for (const part of (match[1] ?? '').split(';')) {
      if (part.length === 0) continue
      const value = Number(part)
      if ((value >= 40 && value <= 47) || (value >= 100 && value <= 107) || value === 48) return true
    }
  }
  return false
}

/** Poll the cumulative stream until `pattern` appears or the deadline lapses.
 *  Stream arrival is arrival-driven (flush gaps double up to their ceiling,
 *  parallel workers and cold working-tree copies add scheduling delay), so
 *  no fixed sleep is a guarantee — a wide one just slows every passing run
 *  and still loses under load. Callers keep their `expect` after the wait:
 *  a deadline miss surfaces as a normal assertion diff, not a helper error. */
export async function waitForMatch(stream: () => string, pattern: RegExp, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pattern.test(stream())) {
    if (Date.now() >= deadline) return
    await waitFor(50)
  }
}

export function sessionWithMessages(texts: readonly string[]): ScannedSession {
  return {
    id: 'preview-wiring-session',
    path: 'preview-wiring-session.jsonl',
    bytes: 1,
    modifiedAt: Date.now(),
    title: 'Preview wiring',
    header: { cwd: process.cwd(), createdAt: Date.now() },
    messages: texts.map((text, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      seq: index + 1,
      at: undefined,
      text,
    })),
  }
}

export async function mount(
  session: ScannedSession,
  options: {
    query?: string
    columns?: number
    rows?: number
    /** Scene layout override — the split-layout tests pin both forms and
     *  the width fallback (default resolved layout is 'split'). */
    layout?: 'split' | 'classic'
    /** Scanner override — the progressive-streaming tests gate the sweep. */
    scanner?: {
      scan(options: { onSession?: (session: ScannedSession) => void }): Promise<readonly ScannedSession[]>
    }
    /** Scene-level notifier spy — the toast-channel tests assert dispatch. */
    notify?: (text: string, tone: 'info' | 'error') => void
    /** Mount inside the host's AlternateScreen (as the real host mounts
     *  plugin scenes), enabling alt-screen mouse dispatch: click/hover/
     *  context-menu delivery is gated on altScreenActive in the host ink,
     *  so pointer-driven wiring tests need this. */
    fullscreen?: boolean
  } = {},
): Promise<Harness> {
  const columns = options.columns ?? 80
  const rows = options.rows ?? 12
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    isRaw?: boolean
    setRawMode(mode: boolean): PassThrough
    ref(): void
    unref(): void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.ref = () => {}
  stdin.unref = () => {}

  let output = ''
  let closeCount = 0
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString()
      callback()
    },
  }) as Writable & {
    isTTY: boolean
    columns: number
    rows: number
    getColorDepth(): number
    fd?: number
  }
  stdout.isTTY = true
  stdout.columns = columns
  stdout.rows = rows
  stdout.getColorDepth = () => 8

  const channel = {
    cwd: process.cwd(),
    working: false,
    resumeTo: async () => ({ ok: false as const, reason: 'cancelled' as const }),
  }
  const scanner = options.scanner ?? { scan: async () => [session] }
  const props = {
    React,
    ui: hostUi,
    channel,
    close: () => {
      closeCount += 1
    },
    config: resolveConfig({
      defaultScope: 'all',
      ...(options.layout === undefined ? {} : { layout: options.layout }),
    }),
    scanner,
    initialQuery: () => options.query ?? 'needle',
    notify: options.notify,
  }
  const instance = await hostUi.render(
    options.fullscreen === true
      ? React.createElement(hostUi.AlternateScreen, null, React.createElement(FindScene, props))
      : React.createElement(FindScene, props),
    {
      stdout,
      stdin,
      stderr: process.stderr,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  await waitFor()

  /** One SGR mouse report; col/row are the 1-indexed terminal cells a real
   *  terminal sends, final byte M for press motion, m for release. */
  const sgrMouse = (button: number, col: number, row: number, final: 'M' | 'm'): string =>
    `\u001b[<${button};${col};${row}${final}`

  /** The last painted frame, ANSI intact. Frame anchor: the host writes each
   *  frame as one buffer headed by the DEC 2026 begin marker — or, on
   *  alt-screen frames when the terminal env claims no synchronized-output
   *  support, by the bare SGR-reset + OSC-8-close frame head. Taking the
   *  later of the two keeps `latest()` meaning "the last painted frame" in
   *  both modes. */
  const frameTail = (): string => {
    const syncStart = output.lastIndexOf('\u001b[?2026h')
    const headStart = output.lastIndexOf('\u001b[0m\u001b]8;;')
    const start = Math.max(syncStart, headStart)
    return start < 0 ? output : output.slice(start)
  }

  return {
    send(input: string) {
      stdin.write(input)
    },
    movePointer(col, row) {
      // Button 35 = no-button motion (mode-1003): the hover path.
      stdin.write(sgrMouse(35, col, row, 'M'))
    },
    clickAt(col, row) {
      stdin.write(sgrMouse(0, col, row, 'M') + sgrMouse(0, col, row, 'm'))
    },
    rightClickAt(col, row) {
      stdin.write(sgrMouse(2, col, row, 'M') + sgrMouse(2, col, row, 'm'))
    },
    all() {
      return stripAnsi(output)
    },
    latest() {
      return stripAnsi(frameTail())
    },
    raw() {
      return output
    },
    rawLatest() {
      return frameTail()
    },
    closed() {
      return closeCount
    },
    resize(columns, rows) {
      stdout.columns = columns
      stdout.rows = rows
      stdout.emit('resize')
    },
    dispose() {
      // Ink's TTY cleanup uses writeSync on fd 1 when no fd is present. Mark
      // the test stream non-TTY before unmounting so the harness stays quiet.
      stdout.isTTY = false
      instance.unmount()
    },
  }
}
