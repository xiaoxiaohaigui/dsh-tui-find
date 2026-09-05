/**
 * The shared scene harness: mounts a real FindScene against the real host
 * ui kit with fake stdin/stdout streams, exposing key sending, frame
 * capture and close counting. Used by every scene-level wiring test —
 * preview-wiring.test.ts and scene.test.ts speak the same harness so their
 * frames are captured and stripped identically.
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
  all(): string
  latest(): string
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
    /** Scanner override — the progressive-streaming tests gate the sweep. */
    scanner?: {
      scan(options: { onSession?: (session: ScannedSession) => void }): Promise<readonly ScannedSession[]>
    }
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
