/**
 * The sidebar panel's component (src/panel.tsx), rendered against the REAL
 * host ui kit with captured frames — the same stream scaffolding the scene
 * harness and the warm-up view tests use, minus the host's panel adapter
 * (which needs a 0.13.0 host this repo does not build against). What is
 * pinned here is what the component itself owes: the layout it draws from a
 * store snapshot, and the keyboard dispatcher it registers through
 * `host.onKey` — including the two rules that only exist because the host
 * swallows every unconsumed plain key in a focused sidebar.
 */
import { Writable, PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import React from 'react'
import * as hostUi from '../node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ui.js'
import { resolveConfig, type Config } from '../src/config.js'
import type { ScanOptions, ScannedSession, SessionScanner } from '../src/core/scan.js'
import { setLangOverride } from '../src/i18n.js'
import { buildFindPanelComponent, type FindPanelProps, type PanelHostApi, type PanelKeyEvent } from '../src/panel.js'
import { FindPanelDriver } from '../src/panel-model.js'
import { stripAnsi, waitForMatch, waitUntil } from './harness.js'

process.env['DSH_TUI_FIND_WATERMARK'] = 'off'

/** The one cwd the fixture's host snapshot and its stub sessions share — the
 *  row model filters by it in the default (repo) scope, so the two must agree
 *  for the recent list to carry a card at all. */
const STUB_CWD = 'P:\\stub'

/** The panel's Divider: the host adapter hands the design-system one, which
 *  the 0.9.3 kit this repo builds against does not ship — a one-row rule is
 *  all the panel asks of it. */
function StubDivider(): React.ReactElement {
  return React.createElement(
    hostUi.Box,
    null,
    React.createElement(hostUi.Text, { dimColor: true }, '─'.repeat(20)),
  )
}

function stubSession(id: string, matches = 1): ScannedSession {
  return {
    id,
    path: `P:\\stub\\${id}\\session.jsonl`,
    bytes: 10,
    modifiedAt: 1_700_000_000_000,
    title: `Title ${id}`,
    header: { cwd: STUB_CWD, createdAt: undefined },
    messages: Array.from({ length: 4 }, (_unused, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      seq: index + 1,
      at: undefined,
      text: index < matches ? `needle in ${id} #${index}` : `other text ${index}`,
    })),
  }
}

function stubScanner(sessions: readonly ScannedSession[]) {
  return {
    scan: async (options: ScanOptions) => {
      options.onSession?.(sessions[0]!)
      return [...sessions]
    },
  }
}

interface ViewFixture {
  driver: FindPanelDriver
  opened: Array<{ query: string; rowId?: string }>
  listeners: Set<(event: PanelKeyEvent) => void>
  /** Deliver one key the way the host's panel dispatcher does; answers whether
   *  the panel consumed it (preventDefault). */
  send(input: string, key: Record<string, unknown> = {}): boolean
  output(): string
  latest(): string
  unmount(): void
}

async function mountPanel(
  options: {
    config?: Config
    sessions?: readonly ScannedSession[]
    width?: number
    height?: number
    focused?: boolean
    /** Warm the store before the component paints (default). The layout
     *  assertions need a frame painted from scratch: a DIFFED repaint writes
     *  the "0 sessions" → "1 sessions" edit as a one-cell patch, so a
     *  multi-word line is only guaranteed to appear intact in a full frame. */
    prewarm?: boolean
  } = {},
): Promise<ViewFixture> {
  const sessions = options.sessions ?? [stubSession('a')]
  const opened: Array<{ query: string; rowId?: string }> = []
  const driver = new FindPanelDriver({
    scanner: stubScanner(sessions) as unknown as SessionScanner,
    config: () => resolveConfig(options.config ?? {}),
    isSceneOpen: () => false,
    openScene: seed => {
      opened.push({ query: seed.query, ...(seed.rowId === undefined ? {} : { rowId: seed.rowId }) })
      return true
    },
  })
  const listeners = new Set<(event: PanelKeyEvent) => void>()
  const host: PanelHostApi = {
    snapshot: () => ({ sessionId: 'session', cwd: STUB_CWD }),
    onKey: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const width = options.width ?? 40
  const height = options.height ?? 16
  const ui = {
    Box: hostUi.Box,
    Text: hostUi.Text,
    Divider: StubDivider,
    useTerminalSize: () => ({ columns: width, rows: height }),
  } as unknown as FindPanelProps['ui']
  const Component = buildFindPanelComponent(driver)

  // Warm the store BEFORE the component's first paint, in the order the mount
  // effects run: hand over the host's cwd (in the default repo scope the row
  // model builds no card without it) and let the index settle, so the first
  // paint is the settled one. This is what makes the layout assertions below
  // hold on any runner: a frame painted from scratch is the only place a
  // multi-word line is guaranteed to appear whole, because a DIFFED repaint
  // rewrites just the differing cells — the "0 sessions" → "1 sessions" edit
  // lands in the cumulative stream as a lone "1" with a cursor move where the
  // rest of the line used to be (measured: the cold-first variant of this test
  // fails with exactly the CI signature). `attach()` is idempotent, so the
  // mount effect's own call starts no sweep — that cold-path attach is what the
  // progress test at the bottom pins, since this fixture no longer exercises it.
  if (options.prewarm !== false) {
    driver.attach()
    driver.setRepoCwd(STUB_CWD)
    await waitUntil(() => driver.getSnapshot().rows.length > 0)
  }

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode(mode: boolean): PassThrough
    ref(): void
    unref(): void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.ref = () => {}
  stdin.unref = () => {}
  let output = ''
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString()
      callback()
    },
  }) as Writable & { isTTY: boolean; columns: number; rows: number; getColorDepth(): number }
  stdout.isTTY = true
  stdout.columns = width
  stdout.rows = height
  stdout.getColorDepth = () => 8

  const instance = await hostUi.render(
    React.createElement(Component, {
      React,
      ui,
      host,
      width,
      height,
      focused: options.focused ?? true,
      visible: true,
      mode: 'split',
    }),
    { stdout, stdin, stderr: process.stderr, patchConsole: false, exitOnCtrlC: false },
  )
  await new Promise(resolve => setTimeout(resolve, 60))

  return {
    driver,
    opened,
    listeners,
    send(input, key = {}) {
      let consumed = false
      const event: PanelKeyEvent = {
        input,
        key: key as PanelKeyEvent['key'],
        preventDefault: () => {
          consumed = true
        },
      }
      for (const listener of [...listeners]) listener(event)
      return consumed
    },
    output: () => stripAnsi(output),
    latest: () => {
      const start = output.lastIndexOf('\u001b[?2026h')
      return stripAnsi(start < 0 ? output : output.slice(start))
    },
    unmount: () => {
      stdout.isTTY = false
      instance.unmount()
    },
  }
}

beforeEach(() => {
  setLangOverride('en')
})

afterEach(() => {
  setLangOverride(undefined)
})

describe('find panel component', () => {
  it('draws the query line, the counts and the result rows', async () => {
    const view = await mountPanel()
    try {
      // An empty query is the recent list: the placeholder sits on the query
      // line and the card carries the session. Ink re-renders differentially,
      // so content is asserted against the cumulative stream — and the fixture
      // warms the store first, so the frame carrying all three of these is
      // painted whole rather than diffed against a cold one.
      expect(view.output()).toMatch(/Type\s*to\s*search/)
      expect(view.output()).toMatch(/Title\s*a/)
      expect(view.output()).toMatch(/1\s*sessions/)

      // The store updates synchronously on delivery; only the repaint lags.
      view.send('n')
      view.send('eedle')
      const snapshot = view.driver.getSnapshot()
      expect(snapshot.query).toBe('needle')
      expect(snapshot.hits).toHaveLength(1)
      // Card + its one hit row: the list is the same row model the scene draws.
      expect(snapshot.rows.map(row => row.rowId)).toEqual(['s:a', 'm:a:0'])
      await waitForMatch(() => view.output(), /needle/)
    } finally {
      view.unmount()
    }
  })

  it('consumes typed characters and deletes them a code point at a time', async () => {
    const view = await mountPanel()
    try {
      // A focused sidebar swallows plain keys nobody consumes, so the panel
      // must claim every character it wants.
      expect(view.send('a')).toBe(true)
      expect(view.send('你')).toBe(true)
      expect(view.driver.getSnapshot().query).toBe('a你')

      // Backspace arrives with the flag on this host…
      expect(view.send('', { backspace: true })).toBe(true)
      expect(view.driver.getSnapshot().query).toBe('a')
      // …and the raw byte is the fallback if a future adapter stops carrying it.
      expect(view.send('\x7f')).toBe(true)
      expect(view.driver.getSnapshot().query).toBe('')
    } finally {
      view.unmount()
    }
  })

  it('clears the query on Esc and hands an empty Esc back to the host', async () => {
    const view = await mountPanel()
    try {
      view.send('needle')
      expect(view.send('', { escape: true })).toBe(true)
      expect(view.driver.getSnapshot().query).toBe('')
      // The empty query is the host's: not consuming is what returns focus to
      // the chat (the panel's documented way out).
      expect(view.send('', { escape: true })).toBe(false)
    } finally {
      view.unmount()
    }
  })

  it('moves with the arrows and opens the selected row on Enter', async () => {
    const view = await mountPanel({ sessions: [stubSession('a'), stubSession('b')] })
    try {
      expect(view.send('', { downArrow: true })).toBe(true)
      expect(view.driver.getSnapshot().selected).toBe(1)
      expect(view.send('', { upArrow: true })).toBe(true)
      expect(view.driver.getSnapshot().selected).toBe(0)
      expect(view.send('', { pageDown: true })).toBe(true)

      view.driver.select(0)
      expect(view.send('', { return_: true })).toBe(true)
      expect(view.opened).toEqual([{ query: '', rowId: 's:a' }])
    } finally {
      view.unmount()
    }
  })

  it('folds from Tab and paging from PgUp/PgDn', async () => {
    const view = await mountPanel({ sessions: [stubSession('a', 4)], config: {} })
    try {
      view.send('needle')
      const collapsed = view.driver.getSnapshot().rows.length
      expect(view.send('\t')).toBe(true)
      expect(view.driver.getSnapshot().rows.length).toBeGreaterThan(collapsed)
      expect(view.driver.getSnapshot().expanded.has('a')).toBe(true)
      expect(view.send('', { tab: true })).toBe(true)
      expect(view.driver.getSnapshot().expanded.has('a')).toBe(false)

      expect(view.send('', { pageUp: true })).toBe(true)
      expect(view.driver.getSnapshot().selected).toBe(0)
    } finally {
      view.unmount()
    }
  })

  it('unsubscribes its key listener when the panel unmounts', async () => {
    const view = await mountPanel()
    expect(view.listeners.size).toBe(1)
    view.unmount()
    // The host's adapter keeps one listener set per panel instance: a leaked
    // registration would keep dispatching keys into a dead component (and, on
    // a remount, deliver every key twice). Polled rather than slept on —
    // cleanup lands on React's schedule, not on the test's.
    await waitForMatch(() => String(view.listeners.size), /^0$/)
    expect(view.listeners.size).toBe(0)
  })

  it('shows the sweep progress and the empty state while the index builds', async () => {
    const pending: Array<(sessions: ScannedSession[]) => void> = []
    const driver = new FindPanelDriver({
      scanner: {
        scan: (options: ScanOptions) =>
          new Promise<ScannedSession[]>(resolve => {
            pending.push(resolve)
            options.onProgress?.({ resolved: 2, total: 9, decodedBytes: 1, resumed: 0, hiddenSubagents: 0 })
          }),
      } as unknown as SessionScanner,
      config: () => resolveConfig({}),
      isSceneOpen: () => false,
      openScene: () => true,
    })
    const listeners = new Set<(event: PanelKeyEvent) => void>()
    const ui = {
      Box: hostUi.Box,
      Text: hostUi.Text,
      Divider: StubDivider,
      useTerminalSize: () => ({ columns: 40, rows: 16 }),
    } as unknown as FindPanelProps['ui']
    const Component = buildFindPanelComponent(driver)
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(m: boolean): PassThrough; ref(): void; unref(): void }
    stdin.isTTY = true
    stdin.setRawMode = () => stdin
    stdin.ref = () => {}
    stdin.unref = () => {}
    let output = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    }) as Writable & { isTTY: boolean; columns: number; rows: number; getColorDepth(): number }
    stdout.isTTY = true
    stdout.columns = 40
    stdout.rows = 16
    stdout.getColorDepth = () => 8
    const instance = await hostUi.render(
      React.createElement(Component, {
        React,
        ui,
        host: {
          snapshot: () => ({ sessionId: 'session', cwd: STUB_CWD }),
          onKey: (listener: (event: PanelKeyEvent) => void) => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
        },
        width: 40,
        height: 16,
        focused: true,
        visible: true,
        mode: 'split',
      }),
      { stdout, stdin, stderr: process.stderr, patchConsole: false, exitOnCtrlC: false },
    )
    await new Promise(resolve => setTimeout(resolve, 60))
    try {
      // Ink re-renders differentially, so content is asserted against the
      // cumulative stream rather than one frame; the first paint carries both
      // lines, so the poll is a formality under load.
      await waitForMatch(() => stripAnsi(output), /Scanning\s*2\/9/)
      const frame = stripAnsi(output)
      expect(frame).toMatch(/Scanning\s*2\/9/)
      expect(frame).toMatch(/Reading\s*sessions/)
    } finally {
      stdout.isTTY = false
      instance.unmount()
      for (const resolve of pending) resolve([])
    }
  })
})
