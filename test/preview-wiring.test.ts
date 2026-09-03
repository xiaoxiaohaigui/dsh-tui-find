import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { afterAll, describe, expect, it } from 'vitest'
import * as hostUi from '../node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ui.js'
import { resolveConfig } from '../src/config.js'
import { setLangOverride } from '../src/i18n.js'
import type { ScannedSession } from '../src/core/scan.js'
import { FindScene } from '../src/scene.js'

setLangOverride('en')
process.env['SSH_CONNECTION'] ??= 'preview-wiring-test'
// One language for the whole file (every frame assertion below is en), and
// restored once after ALL describes — a per-describe afterAll would reset
// the override for every later describe in this file.
afterAll(() => setLangOverride(undefined))

type Harness = {
  send(input: string): void
  all(): string
  latest(): string
  closed(): number
  dispose(): void
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

function waitFor(ms = 100): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sessionWithMessages(texts: readonly string[]): ScannedSession {
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

async function mount(
  session: ScannedSession,
  options: { query?: string; columns?: number; rows?: number } = {},
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
  const scanner = { scan: async () => [session] }
  const props = {
    React,
    ui: hostUi,
    channel,
    close: () => {
      closeCount += 1
    },
    config: resolveConfig({ defaultScope: 'all' }),
    scanner,
    initialQuery: () => options.query ?? 'needle',
  }
  const instance = await hostUi.render(React.createElement(FindScene, props), {
    stdout,
    stdin,
    stderr: process.stderr,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  await waitFor()

  return {
    send(input: string) {
      stdin.write(input)
    },
    all() {
      return stripAnsi(output)
    },
    latest() {
      const start = output.lastIndexOf('\u001b[?2026h')
      return stripAnsi(start < 0 ? output : output.slice(start))
    },
    closed() {
      return closeCount
    },
    dispose() {
      // Ink's TTY cleanup uses writeSync on fd 1 when no fd is present. Mark
      // the test stream non-TTY before unmounting so the harness stays quiet.
      stdout.isTTY = false
      instance.unmount()
    },
  }
}

describe('preview scene wiring', () => {
  it('owns preview typing and returns through preview, query, then close layers', async () => {
    const harness = await mount(sessionWithMessages(['intro', 'needle one', 'tail']))
    try {
      harness.send('\u001bp')
      await waitFor()

      harness.send('x')
      await waitFor()
      harness.send('\u001b')
      await waitFor()
      expect(harness.all()).not.toContain('needlex')
      expect(harness.latest()).toContain('needle')

      harness.send('\u001b')
      await waitFor()
      expect(harness.latest()).toMatch(/Type\s*to\s*search/)

      harness.send('\u001b')
      await waitFor()
      expect(harness.closed()).toBe(1)
    } finally {
      harness.dispose()
    }
  })

  it('walks hits with n/N and reports the boundary', async () => {
    const harness = await mount(sessionWithMessages(['intro', 'needle one', 'middle', 'needle two is longer']))
    try {
      harness.send('\u001bp')
      await waitFor()
      harness.send('n')
      await waitFor()
      expect(harness.all()).toContain('Hit1/2')
      harness.send('\u001bc')
      await waitFor()
      expect(harness.latest()).toMatch(/Copied\s*15\s*chars/)
      harness.send('n')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      expect(harness.latest()).toMatch(/Copied\s*25\s*chars/)
      harness.send('N')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      expect(harness.latest()).toMatch(/Copied\s*15\s*chars/)
      harness.send('N')
      await waitFor()
      expect(harness.latest()).toMatch(/more\s*hits/)
    } finally {
      harness.dispose()
    }
  })

  it('uses rows minus preview chrome for PgDn and copies the cursor message', async () => {
    const harness = await mount(
      sessionWithMessages(['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'ggggggg', 'hhhhhhhh']),
      { query: '', rows: 10 },
    )
    try {
      harness.send('\u001bp')
      await waitFor()
      harness.send('\u001b[B')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      expect(harness.all()).toContain('Copied7chars')

      // rows=10 and four fixed preview chrome lines leave a six-line page.
      // Every message is two lines (header + body), so PgDn lands on message 3.
      harness.send('\u001b[6~')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      expect(harness.latest().trim()).toMatch(/9$/)

      harness.send('\u001b[5~')
      await waitFor()
      harness.send('\u001bc')
      await waitFor()
      expect(harness.latest().trim()).toMatch(/7$/)
    } finally {
      harness.dispose()
    }
  })

  it('keeps a narrow preview header on one physical row', async () => {
    const base = sessionWithMessages(['body'])
    const session: ScannedSession = {
      ...base,
      messages: base.messages.map(message => ({ ...message, seq: Number.MAX_SAFE_INTEGER })),
    }
    const harness = await mount(session, { query: '', columns: 20, rows: 12 })
    try {
      harness.send('\u001bp')
      await waitFor()
      // The marker consumes two columns; the remaining header is truncated
      // with an ellipsis instead of wrapping into the one-weight scroll list.
      // (\s* not \s+: the diff-based repaint skips cells that already held a
      // space in the previous frame, so the stripped stream can drop the one
      // between the role label and the seq without the row being wrapped.)
      expect(harness.all()).toMatch(/You\s*#9007199254…/)
    } finally {
      harness.dispose()
    }
  })
})

describe('help panel wiring', () => {
  it('opens with Alt+H, swallows typing, and returns through Alt+H and Esc', async () => {
    const harness = await mount(sessionWithMessages(['intro']))
    try {
      harness.send('\u001bh')
      await waitFor()
      // The panel body paints (sections, rows, footer). Frame-level capture
      // quirks exist around the host renderer's cell diff (row 1 and the
      // close frame), so the assertions below stay on cumulative-stream and
      // mode-level evidence rather than exact final frames.
      expect(harness.all()).toMatch(/Toggle\s*regex/)
      // Typing on the help screen must never leak into the query.
      harness.send('x')
      await waitFor()
      expect(harness.all()).not.toContain('needlex')
      // Alt+H closes the panel; Esc then clears the query — proof the scene
      // is really back in list mode answering its own keys again.
      harness.send('\u001bh')
      await waitFor()
      harness.send('\u001b')
      await waitFor()
      expect(harness.latest()).toMatch(/Type\s*to\s*search/)
    } finally {
      harness.dispose()
    }
  })
})
