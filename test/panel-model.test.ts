/**
 * The sidebar panel's state core (src/panel-model.ts): the sweep the panel
 * owns, the search derivation it shares with the scene, the selection rules,
 * and the handoff into the full-screen scene. No React here — the component
 * only renders this store (panel-view.test.ts mounts it).
 */
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig, type Config } from '../src/config.js'
import type { ScanOptions, ScannedSession, SessionScanner } from '../src/core/scan.js'
import { t } from '../src/i18n.js'
import { FindPanelDriver, type PanelSnapshot } from '../src/panel-model.js'
import { SweepGate } from '../src/sweep-gate.js'

// No test ever writes the real watermark journal.
process.env['DSH_TUI_FIND_WATERMARK'] = 'off'

interface ScanCall {
  options: ScanOptions
  resolve(sessions?: ScannedSession[]): void
  reject(error: unknown): void
}

function stubScanner() {
  const calls: ScanCall[] = []
  return {
    calls,
    scan(options: ScanOptions): Promise<ScannedSession[]> {
      return new Promise((resolve, reject) => {
        calls.push({ options, resolve: (sessions = []) => resolve(sessions), reject })
      })
    },
  }
}

type StubScanner = ReturnType<typeof stubScanner>

/** A session with `messages` searchable messages, `matches` of which contain
 *  the word `needle` (the fold tests need more hits than the preview budget).
 *  `modifiedAt` drives the MRU order the scanner would return; the driver
 *  trusts the array as given. */
function stubSession(
  id: string,
  options: { cwd?: string; modifiedAt?: number; messages?: number; matches?: number } = {},
): ScannedSession {
  const messages = options.messages ?? 2
  const matches = options.matches ?? 1
  return {
    id,
    path: `P:\\stub\\${id}\\session.jsonl`,
    bytes: 10,
    modifiedAt: options.modifiedAt ?? 1_700_000_000_000,
    title: `Title ${id}`,
    header: { cwd: options.cwd ?? 'P:\\stub', createdAt: undefined },
    messages: Array.from({ length: messages }, (_unused, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      seq: index + 1,
      at: undefined,
      text: index < matches ? `needle in ${id} #${index}` : `other text ${index} of ${id}`,
    })),
  }
}

interface PanelFixture {
  driver: FindPanelDriver
  scanner: StubScanner
  opened: Array<{ query: string; rowId?: string; expanded: readonly string[] }>
  setConfig(config: Config): void
  setSceneOpen(open: boolean): void
  failNextOpen(): void
  snapshot(): PanelSnapshot
}

function makeDriver(
  config: Config = {},
  options: { gate?: SweepGate } = {},
): PanelFixture {
  const scanner = stubScanner()
  const opened: Array<{ query: string; rowId?: string; expanded: readonly string[] }> = []
  let currentConfig: Config = config
  let sceneOpen = false
  let refuseOpen = false
  const driver = new FindPanelDriver({
    scanner: scanner as unknown as SessionScanner,
    config: () => resolveConfig(currentConfig),
    isSceneOpen: () => sceneOpen,
    ...(options.gate === undefined ? {} : { gate: options.gate }),
    openScene: seed => {
      if (refuseOpen) return false
      opened.push({
        query: seed.query,
        ...(seed.rowId === undefined ? {} : { rowId: seed.rowId }),
        expanded: seed.expanded ?? [],
      })
      return true
    },
  })
  // The view pushes the host's curated cwd right after mount, and the default
  // repo scope needs it: without a cwd "this repo" matches nothing (by
  // design). The tests stand in for that push.
  driver.setRepoCwd('P:\\stub')
  return {
    driver,
    scanner,
    opened,
    setConfig(next) {
      currentConfig = next
    },
    setSceneOpen(open) {
      sceneOpen = open
    },
    failNextOpen() {
      refuseOpen = true
    },
    snapshot: () => driver.getSnapshot(),
  }
}

/** Drain the sweep's promise chain (scan → then → settle). */
async function flush(): Promise<void> {
  for (let at = 0; at < 5; at++) await new Promise(resolve => setImmediate(resolve))
}

const GATE = { resolved: 1, total: 2, decodedBytes: 10, resumed: 0, hiddenSubagents: 0 }

describe('FindPanelDriver — the sweep', () => {
  it('sweeps lazily on attach, and never twice at once', async () => {
    const fixture = makeDriver()
    expect(fixture.snapshot().phase).toBe('cold')
    expect(fixture.scanner.calls).toEqual([])

    fixture.driver.attach()
    expect(fixture.snapshot().phase).toBe('indexing')
    expect(fixture.scanner.calls).toHaveLength(1)
    // The scan inherits the plugin's own posture (sub-agents default off).
    expect(fixture.scanner.calls[0]!.options.includeSubagents).toBe(false)

    // Idempotent while one is in flight: re-mounting mid-sweep (a tab switch
    // back, a sidebar reopen) does not stack a second decode.
    fixture.driver.attach()
    expect(fixture.scanner.calls).toHaveLength(1)

    fixture.scanner.calls[0]!.resolve([stubSession('a')])
    await flush()
    expect(fixture.snapshot().phase).toBe('ready')
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:a'])
  })

  it('re-sweeps on the next attach, so content added since the last sweep is found', async () => {
    // R-135: a settled sweep used to be final for the whole activation, so
    // sessions created (or messages appended) after it were searchable in the
    // scene — which re-sweeps on every mount — and invisible in the panel.
    const fixture = makeDriver()
    fixture.driver.attach()
    fixture.scanner.calls[0]!.resolve([stubSession('a')])
    await flush()
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:a'])

    // Back to the tab after the settle: one fresh pass, over the rows already
    // on screen (the list does not blank out while it runs).
    fixture.driver.detach()
    fixture.driver.attach()
    expect(fixture.scanner.calls).toHaveLength(2)
    expect(fixture.snapshot().phase).toBe('indexing')
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:a'])

    fixture.scanner.calls[1]!.resolve([stubSession('b', { modifiedAt: 400 }), stubSession('a')])
    await flush()
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:b', 's:a'])
  })

  it('streams sessions in as the sweep yields them', async () => {
    const fixture = makeDriver()
    fixture.driver.attach()
    const call = fixture.scanner.calls[0]!
    call.options.onProgress?.({ ...GATE, resolved: 1, total: 9 })
    call.options.onSession?.(stubSession('a', { modifiedAt: 5 }))
    // The first arrival is always due (the flush clock starts at 0).
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:a'])
    expect(fixture.snapshot().progress?.total).toBe(9)
  })

  it('settles the withheld sub-agent count after the sweep clears progress', async () => {
    const fixture = makeDriver()
    fixture.driver.attach()
    const call = fixture.scanner.calls[0]!
    call.options.onProgress?.({ ...GATE, resolved: 1, total: 2, hiddenSubagents: 7 })
    call.resolve([stubSession('a')])
    await flush()
    expect(fixture.snapshot().progress).toBeUndefined()
    expect(fixture.snapshot().hiddenSubagents).toBe(7)
  })

  it('reports a failed sweep as a notice instead of an empty list', async () => {
    const fixture = makeDriver()
    fixture.driver.attach()
    fixture.scanner.calls[0]!.reject(new Error('boom'))
    await flush()
    const settled = fixture.snapshot()
    expect(settled.phase).toBe('failed')
    expect(settled.progress).toBeUndefined()
    expect(settled.notice?.tone).toBe('error')
    expect(settled.notice?.text).toContain('boom')
  })

  it('aborts an in-flight sweep and frees the slot on dispose', () => {
    const gate = new SweepGate()
    const fixture = makeDriver({}, { gate })
    fixture.driver.attach()
    const call = fixture.scanner.calls[0]!
    expect(gate.current()).toBe('panel')

    fixture.driver.dispose()
    expect(call.options.signal?.aborted).toBe(true)
    // Nothing outlives the activation: a held claim would block the warm-up
    // of a re-activated row for the rest of the process.
    expect(gate.current()).toBeUndefined()
  })

  it('gives a failed sweep one more chance on the next attach', async () => {
    const fixture = makeDriver()
    fixture.driver.attach()
    fixture.scanner.calls[0]!.reject(new Error('boom'))
    await flush()
    expect(fixture.snapshot().phase).toBe('failed')

    // Coming back to the tab is the retry affordance: a transient read error
    // must not leave the panel dead for the whole session.
    fixture.driver.attach()
    expect(fixture.scanner.calls).toHaveLength(2)
    expect(fixture.snapshot().phase).toBe('indexing')
    fixture.scanner.calls[1]!.resolve([stubSession('a')])
    await flush()
    expect(fixture.snapshot().phase).toBe('ready')
    expect(fixture.snapshot().notice).toBeUndefined()
  })

  it('never lets a superseded sweep’s late rejection settle the newer one', async () => {
    const gate = new SweepGate()
    const fixture = makeDriver({}, { gate })
    fixture.driver.attach()
    const stale = fixture.scanner.calls[0]!

    // The scene opens: the stale sweep is aborted and the panel drops to cold.
    fixture.setSceneOpen(true)
    stale.options.onProgress?.(GATE)
    expect(stale.options.signal?.aborted).toBe(true)
    expect(fixture.snapshot().phase).toBe('cold')

    // Back from the scene: a NEW sweep holds the slot.
    fixture.setSceneOpen(false)
    fixture.driver.attach()
    expect(fixture.scanner.calls).toHaveLength(2)
    expect(gate.current()).toBe('panel')

    // The stale promise now rejects (a real I/O error, delivered late). It
    // must not flip the live sweep to failed nor release its claim.
    stale.reject(new Error('late io failure'))
    await flush()
    expect(fixture.snapshot().phase).toBe('indexing')
    expect(fixture.snapshot().notice).toBeUndefined()
    expect(gate.current()).toBe('panel')

    fixture.scanner.calls[1]!.resolve([stubSession('a')])
    await flush()
    expect(fixture.snapshot().phase).toBe('ready')
    expect(gate.current()).toBeUndefined()
  })

  it('restarts a sweep aborted by an opening scene, and keeps the old rows meanwhile', async () => {
    const fixture = makeDriver()
    fixture.driver.attach()
    const call = fixture.scanner.calls[0]!
    call.options.onSession?.(stubSession('a'))
    const before = fixture.snapshot().rows

    fixture.setSceneOpen(true)
    call.options.onProgress?.(GATE)
    expect(call.options.signal?.aborted).toBe(true)
    // The scene runs its own sweep; this panel drops to cold so the next
    // attach re-sweeps (against the cache this sweep already warmed), while
    // the rows already in the store stay on screen.
    expect(fixture.snapshot().phase).toBe('cold')
    expect(fixture.snapshot().rows).toBe(before)
    expect(fixture.snapshot().progress).toBeUndefined()

    fixture.setSceneOpen(false)
    fixture.driver.attach()
    expect(fixture.scanner.calls).toHaveLength(2)
  })
})

describe('FindPanelDriver — the search derivation', () => {
  async function ready(config: Config = {}): Promise<PanelFixture> {
    const fixture = makeDriver(config)
    fixture.driver.attach()
    fixture.scanner.calls[0]!.resolve([
      stubSession('a', { modifiedAt: 300 }),
      stubSession('b', { modifiedAt: 200 }),
    ])
    await flush()
    return fixture
  }

  it('lists recent sessions while the query is empty', async () => {
    const fixture = await ready()
    expect(fixture.snapshot().hits).toEqual([])
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:a', 's:b'])
  })

  it('searches on typing and clears back to recent mode', async () => {
    const fixture = await ready()
    fixture.driver.appendInput('needle')
    const searched = fixture.snapshot()
    expect(searched.query).toBe('needle')
    expect(searched.hits.map(hit => hit.session.id)).toEqual(['a', 'b'])
    expect(searched.rows[0]?.kind).toBe('session')

    // Backspace removes one code point of the query; Esc's clear goes through
    // setQuery('').
    fixture.driver.backspace()
    expect(fixture.snapshot().query).toBe('needl')
    fixture.driver.setQuery('')
    expect(fixture.snapshot().query).toBe('')
    expect(fixture.snapshot().hits).toEqual([])
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:a', 's:b'])
  })

  it('returns the selection to the top on a query edit, never to the anchored row', async () => {
    // Regression (review F1): the streaming-flush anchor used to run on query
    // edits too, so clearing the query restored the highlight onto whatever
    // row the previous result set had selected instead of the top.
    const fixture = makeDriver()
    fixture.driver.attach()
    fixture.scanner.calls[0]!.resolve([
      stubSession('a', { modifiedAt: 300, matches: 0 }),
      stubSession('b', { modifiedAt: 200, matches: 1 }),
    ])
    await flush()
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:a', 's:b'])

    fixture.driver.appendInput('needle')
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:b', 'm:b:0'])
    expect(fixture.snapshot().selected).toBe(0)

    fixture.driver.setQuery('')
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:a', 's:b'])
    expect(fixture.snapshot().selected).toBe(0)
  })

  it('strips control bytes out of a pasted chunk', async () => {
    const fixture = await ready()
    fixture.driver.appendInput('nee\ndle\tx')
    expect(fixture.snapshot().query).toBe('needlex')
  })

  it('ignores selection, fold and open keys on an empty list', () => {
    const fixture = makeDriver()
    expect(() => {
      fixture.driver.select(3)
      fixture.driver.move(1)
      fixture.driver.page(1, 5)
      fixture.driver.toggleFold()
    }).not.toThrow()
    expect(fixture.snapshot().rows).toEqual([])
    expect(fixture.snapshot().selected).toBe(0)
    expect(fixture.snapshot().expanded.size).toBe(0)
    expect(fixture.driver.openSelected()).toBe(false)
    expect(fixture.opened).toEqual([])
  })

  it('honors the configured repo scope and pushes the cwd through', async () => {
    const fixture = await ready({ defaultScope: 'repo' })
    fixture.driver.appendInput('needle')
    expect(fixture.snapshot().hits.map(hit => hit.session.id)).toEqual(['a', 'b'])

    // A cwd that matches nothing excludes both results — "this repo" is a
    // real filter, not a label (the core's own contract).
    fixture.driver.setRepoCwd('P:\\elsewhere')
    expect(fixture.snapshot().hits).toEqual([])

    fixture.driver.setRepoCwd('P:\\stub')
    expect(fixture.snapshot().hits.map(hit => hit.session.id)).toEqual(['a', 'b'])
  })

  it('honors the titleOnly knob', async () => {
    const fixture = await ready({ titleOnly: true })
    fixture.driver.appendInput('needle')
    expect(fixture.snapshot().hits).toEqual([])
    fixture.driver.setQuery('Title a')
    expect(fixture.snapshot().hits.map(hit => hit.session.id)).toEqual(['a'])
  })

  it('surfaces a refused regular expression instead of an empty result set', async () => {
    const fixture = await ready({ regex: true })
    fixture.driver.appendInput('a('.repeat(1))
    expect(fixture.snapshot().regexRejected).toBe('syntax')
    fixture.driver.setQuery('needle')
    expect(fixture.snapshot().regexRejected).toBeUndefined()
  })
})

describe('FindPanelDriver — selection', () => {
  async function ready(): Promise<PanelFixture> {
    const fixture = makeDriver()
    fixture.driver.attach()
    fixture.scanner.calls[0]!.resolve([stubSession('a'), stubSession('b'), stubSession('c')])
    await flush()
    return fixture
  }

  it('clamps movement to the list', async () => {
    const fixture = await ready()
    fixture.driver.move(-1)
    expect(fixture.snapshot().selected).toBe(0)
    fixture.driver.move(1)
    expect(fixture.snapshot().selected).toBe(1)
    fixture.driver.select(99)
    expect(fixture.snapshot().selected).toBe(2)
    fixture.driver.move(5)
    expect(fixture.snapshot().selected).toBe(2)
  })

  it('pages by one viewport', async () => {
    const fixture = await ready()
    fixture.driver.page(1, 2)
    expect(fixture.snapshot().selected).toBe(2)
    fixture.driver.page(-1, 2)
    expect(fixture.snapshot().selected).toBe(0)
  })

  it('anchors the selection by rowId when a flush inserts a newer session above it', async () => {
    const fixture = makeDriver()
    fixture.driver.attach()
    const call = fixture.scanner.calls[0]!
    // The flush gap doubles with the prefix, so the second arrival needs the
    // clock to move before it is due (SessionFlush's publish schedule).
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000)
    call.options.onSession?.(stubSession('a', { modifiedAt: 100 }))
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:a'])
    fixture.driver.select(0)

    now.mockReturnValue(2_000)
    // A later arrival that is MORE recent sorts above the current row — the
    // index the user was on must follow the row, not the position.
    call.options.onSession?.(stubSession('z', { modifiedAt: 900 }))
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:z', 's:a'])
    expect(fixture.snapshot().selected).toBe(1)
    now.mockRestore()
  })

  it('folds a hit card from the keyboard and unfolds it again', async () => {
    const fixture = makeDriver()
    fixture.driver.attach()
    fixture.scanner.calls[0]!.resolve([stubSession('a', { messages: 8, matches: 8 })])
    await flush()
    fixture.driver.appendInput('needle')
    const collapsed = fixture.snapshot().rows.length
    expect(collapsed).toBe(1 + 3) // the card plus the preview budget

    fixture.driver.toggleFold()
    expect(fixture.snapshot().rows.length).toBeGreaterThan(collapsed)
    expect(fixture.snapshot().expanded.has('a')).toBe(true)

    fixture.driver.toggleFold()
    expect(fixture.snapshot().expanded.has('a')).toBe(false)
    expect(fixture.snapshot().rows.length).toBe(collapsed)
  })

  it('ignores a fold on a recent-mode card (nothing to fold)', async () => {
    const fixture = await ready()
    fixture.driver.toggleFold()
    expect(fixture.snapshot().expanded.size).toBe(0)
  })

  it('keeps the selected session across a fold', async () => {
    const fixture = makeDriver()
    fixture.driver.attach()
    fixture.scanner.calls[0]!.resolve([
      stubSession('a', { messages: 8, matches: 8 }),
      stubSession('b', { messages: 8, matches: 8 }),
    ])
    await flush()
    fixture.driver.appendInput('needle')
    // Select the second session's card (its rows follow the first card + its
    // three preview hits).
    fixture.driver.select(4)
    expect(fixture.snapshot().rows[4]?.rowId).toBe('s:b')

    fixture.driver.toggleFold()
    const afterExpand = fixture.snapshot()
    expect(afterExpand.expanded.has('b')).toBe(true)
    // The fold inserts rows ABOVE the selection; the anchor keeps the user on
    // the same session.
    expect(afterExpand.rows[afterExpand.selected]?.rowId).toBe('s:b')
  })
})

describe('FindPanelDriver — the scene handoff', () => {
  it('hands the query and the selected row to the scene', async () => {
    const fixture = makeDriver()
    fixture.driver.attach()
    fixture.scanner.calls[0]!.resolve([stubSession('a'), stubSession('b')])
    await flush()
    fixture.driver.appendInput('needle')
    // Results mode interleaves cards and their hit rows: s:a, m:a:0, s:b, …
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:a', 'm:a:0', 's:b', 'm:b:0'])
    fixture.driver.select(2)

    expect(fixture.driver.openSelected()).toBe(true)
    expect(fixture.opened).toEqual([{ query: 'needle', rowId: 's:b', expanded: [] }])
  })

  it('hands over the unfolded sessions, so a hit row past the preview budget can land', async () => {
    // R-136: the scene rebuilds the row list, and a folded card carries only
    // PREVIEW_HITS of its hits — a row the panel shows because the user
    // unfolded the card would not exist there.
    const fixture = makeDriver()
    fixture.driver.attach()
    fixture.scanner.calls[0]!.resolve([stubSession('a', { messages: 8, matches: 8 })])
    await flush()
    fixture.driver.appendInput('needle')
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:a', 'm:a:0', 'm:a:1', 'm:a:2'])

    fixture.driver.toggleFold()
    expect(fixture.snapshot().expanded.has('a')).toBe(true)
    const deep = fixture.snapshot().rows.findIndex(row => row.rowId === 'm:a:6')
    expect(deep).toBeGreaterThan(0)
    fixture.driver.select(deep)

    expect(fixture.driver.openSelected()).toBe(true)
    expect(fixture.opened).toEqual([{ query: 'needle', rowId: 'm:a:6', expanded: ['a'] }])
  })

  it('aborts its own sweep before opening the scene', async () => {
    const fixture = makeDriver()
    fixture.driver.attach()
    const call = fixture.scanner.calls[0]!
    call.options.onSession?.(stubSession('a'))
    fixture.driver.openSelected()
    // The scene sweeps on mount; two sweeps at once is what the gate exists
    // to prevent.
    expect(call.options.signal?.aborted).toBe(true)
    expect(fixture.snapshot().phase).toBe('cold')
  })

  it('records a notice when the scene refuses to open', async () => {
    const fixture = makeDriver()
    fixture.driver.attach()
    fixture.scanner.calls[0]!.resolve([stubSession('a')])
    await flush()
    fixture.failNextOpen()
    expect(fixture.driver.openSelected()).toBe(false)
    expect(fixture.snapshot().notice).toEqual({ text: t('panel-open-failed'), tone: 'error' })

    // The notice is not permanent: the user's next edit clears it (the panel
    // has no timer of its own — the scene's status ages out, this one needs a
    // user action).
    fixture.driver.appendInput('n')
    expect(fixture.snapshot().notice).toBeUndefined()
  })

  it('keeps a running sweep alive when the scene refuses to open', async () => {
    // Regression (review F2): the sweep used to be aborted BEFORE the open was
    // attempted, so a refused open left the panel with a dead index and a
    // frozen list.
    const fixture = makeDriver()
    fixture.driver.attach()
    const call = fixture.scanner.calls[0]!
    call.options.onSession?.(stubSession('a'))
    fixture.failNextOpen()

    expect(fixture.driver.openSelected()).toBe(false)
    expect(call.options.signal?.aborted).toBe(false)
    expect(fixture.snapshot().phase).toBe('indexing')
  })

  it('restarts a sweep that had already stood down when the scene refuses to open', () => {
    const fixture = makeDriver()
    fixture.driver.attach()
    const first = fixture.scanner.calls[0]!
    first.options.onSession?.(stubSession('a'))
    // Stand down as if a scene had taken over — then the scene refuses.
    fixture.driver.yieldToScene()
    expect(first.options.signal?.aborted).toBe(true)
    expect(fixture.snapshot().phase).toBe('cold')

    fixture.failNextOpen()
    expect(fixture.driver.openSelected()).toBe(false)
    expect(fixture.scanner.calls).toHaveLength(2)
    expect(fixture.snapshot().phase).toBe('indexing')
  })

  it('restarts a FAILED index when the scene refuses to open, keeping the failure reason', async () => {
    // R-146: the refused-open branch only recognised `cold`, so a panel whose
    // sweep had FAILED (its rows still on screen) stayed failed — and the one
    // line explaining the failure was overwritten by the open error.
    const fixture = makeDriver()
    fixture.driver.attach()
    const failed = fixture.scanner.calls[0]!
    failed.options.onSession?.(stubSession('a'))
    failed.reject(new Error('boom'))
    await flush()
    expect(fixture.snapshot().phase).toBe('failed')
    expect(fixture.snapshot().rows.map(row => row.rowId)).toEqual(['s:a'])

    fixture.failNextOpen()
    expect(fixture.driver.openSelected()).toBe(false)
    expect(fixture.scanner.calls).toHaveLength(2)
    expect(fixture.snapshot().phase).toBe('indexing')
    expect(fixture.snapshot().notice?.tone).toBe('error')
    expect(fixture.snapshot().notice?.text).toContain('boom')

    fixture.scanner.calls[1]!.resolve([stubSession('a')])
    await flush()
    expect(fixture.snapshot().phase).toBe('ready')
  })

  it('is a no-op on an empty list', async () => {
    const fixture = makeDriver()
    fixture.driver.attach()
    fixture.scanner.calls[0]!.resolve([])
    await flush()
    expect(fixture.driver.openSelected()).toBe(false)
    expect(fixture.opened).toEqual([])
  })
})

describe('FindPanelDriver — the background badge', () => {
  it('badges the tab when the index settles with nobody looking', async () => {
    const fixture = makeDriver()
    const setBadge = vi.fn()
    fixture.driver.bindBadge(setBadge)
    fixture.driver.attach()
    fixture.driver.detach() // the user switched tabs mid-sweep

    fixture.scanner.calls[0]!.resolve([stubSession('a')])
    await flush()
    expect(setBadge).toHaveBeenCalledWith({ level: 'info', unread: 0 })
  })

  it('does not badge a settle the panel is watching', async () => {
    const fixture = makeDriver()
    const setBadge = vi.fn()
    fixture.driver.bindBadge(setBadge)
    fixture.driver.attach()

    fixture.scanner.calls[0]!.resolve([stubSession('a')])
    await flush()
    expect(fixture.snapshot().phase).toBe('ready')
    expect(setBadge).not.toHaveBeenCalled()
  })

  it('badges a background failure in the error tone', async () => {
    const fixture = makeDriver()
    const setBadge = vi.fn()
    fixture.driver.bindBadge(setBadge)
    fixture.driver.attach()
    fixture.driver.detach()

    fixture.scanner.calls[0]!.reject(new Error('boom'))
    await flush()
    expect(setBadge).toHaveBeenCalledWith({ level: 'error', unread: 0 })
  })

  it('stands down when the panel row goes off: no sweep, no badge, no stale binding', async () => {
    // R-144: switching the row off used to release the registration only —
    // the in-flight sweep kept decoding for a panel that can never come back,
    // and its settle still called badge() with an id the host no longer owned
    // (the host logs a warn the plugin cannot catch).
    const gate = new SweepGate()
    const fixture = makeDriver({}, { gate })
    const setBadge = vi.fn()
    fixture.driver.bindBadge(setBadge)
    fixture.driver.attach()
    fixture.driver.detach()
    const call = fixture.scanner.calls[0]!
    expect(gate.current()).toBe('panel')

    fixture.driver.standDown()
    expect(call.options.signal?.aborted).toBe(true)
    expect(gate.current()).toBeUndefined()
    // Cleared while the registration is still live (see FindPanelRegistration),
    // then dropped: nothing may address the host with the dead id again.
    expect(setBadge).toHaveBeenCalledWith(null)
    setBadge.mockClear()

    call.resolve([stubSession('a')])
    await flush()
    expect(setBadge).not.toHaveBeenCalled()
    expect(fixture.snapshot().phase).toBe('cold')
  })
})

describe('FindPanelDriver — the single-sweep slot', () => {
  it('preempts the warm-up and frees the slot when it settles', async () => {
    const gate = new SweepGate()
    const warmup = gate.claim('warmup')
    expect(warmup).toBeDefined()

    const fixture = makeDriver({}, { gate })
    fixture.driver.attach()
    expect(warmup!.lost()).toBe(true)
    expect(gate.current()).toBe('panel')

    fixture.scanner.calls[0]!.resolve([stubSession('a')])
    await flush()
    expect(gate.current()).toBeUndefined()
  })

  it('starts no sweep at all when a higher-priority owner holds the slot', () => {
    // No higher-priority owner exists today; the rule is pinned through a
    // stub gate so a future sweeper's rank cannot silently break it.
    const gate = {
      claim: vi.fn(() => undefined),
    } as unknown as SweepGate
    const fixture = makeDriver({}, { gate })
    fixture.driver.attach()
    expect(fixture.scanner.calls).toEqual([])
    expect(fixture.snapshot().phase).toBe('cold')
  })
})
