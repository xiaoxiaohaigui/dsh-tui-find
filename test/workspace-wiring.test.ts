/**
 * The workspace column (three-column split): the pure grouping/geometry model
 * and the scene wiring that drives it — Tab expanding/collapsing the column,
 * the initial selection seeded from `defaultScope`, the live range switch
 * from the column's own cursor, and its pointer vocabulary (a click applies
 * the row and hands the keyboard back; the wheel walks the selection by the
 * host's notch step and clamps at both ends).
 *
 * Frames are read on a forced repaint (`resize`) like the other scene wiring
 * tests: Ink's differential updates only paint changed cells, so a plain
 * update can be a cell diff rather than a whole frame.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

// The focused/unfocused selection block is a STYLE, and chalk strips escapes
// off-TTY: the presenter case below needs coloured output. vi.hoisted runs
// before chalk resolves FORCE_COLOR at module load, and every other assertion
// reads ANSI-stripped frames, so the extra escapes change nothing for them.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1'
})

import * as hostUi from '../node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ui.js'
import React from 'react'
import type { ScannedSession } from '../src/core/scan.js'
import { hasTerminalImageHooks, splitGeometry } from '../src/find-types.js'
import {
  ALL_WORKSPACES_KEY,
  buildWorkspaces,
  WorkspaceList,
  workspaceDisplayLabel,
  workspaceKeyOf,
  workspacePageEntries,
  workspaceRowBackground,
  workspaceShortLabel,
} from '../src/find-workspaces.js'
import { sessionCwdMatches } from '../src/core/search.js'
import { setLangOverride } from '../src/i18n.js'
import { glyphStyle, hasBackground, mount, mountKitComponent, sessionWithMessages, waitFor, waitForMatch } from './harness.js'

setLangOverride('en')
afterAll(() => setLangOverride(undefined))

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The workspace column's own cells: between its left and right borders. The
 *  search card spans the whole width (two border cells only) and is skipped;
 *  every content-row line carries at least the workspace and session columns. */
const workspaceColumn = (frame: string): string =>
  frame
    .split(/\r\n|\r|\n/)
    .filter(line => !line.includes('⌕'))
    .map(line => {
      const parts = line.split('│')
      return parts.length >= 3 ? (parts[1] ?? '') : ''
    })
    .join('\n')

/** The session list's own cells (between the workspace column and the reader
 *  frame, or the line's end when no reader is shown). Used by the empty-state
 *  hint cases, whose copy renders inside this column — not across the viewport
 *  (R-188). */
const listColumn = (frame: string): string =>
  frame
    .split(/\r\n|\r|\n/)
    .filter(line => !line.includes('⌕'))
    .map(line => {
      const parts = line.split('│')
      return parts.length >= 3 ? (parts[2] ?? '') : ''
    })
    .join('\n')

/** The SGR run in front of the FIRST occurrence of `glyph` in a raw frame.
 *  The harness's own glyphStyle reads the LAST one; the workspace name is
 *  repeated in its path line (the tail), so the first occurrence is the one
 *  on the name line. */
const firstGlyphStyle = (frame: string, glyph: string): string => {
  const at = frame.indexOf(glyph)
  if (at < 0) return ''
  return /((?:\u001b\[[0-9;]*m)+)[^\S\r\n]*$/.exec(frame.slice(0, at))?.[1] ?? ''
}

const at = (cwd: string | undefined, id: string, title: string, modifiedAt: number): ScannedSession => ({
  ...sessionWithMessages([`needle ${id}`]),
  id,
  title,
  modifiedAt,
  header: { ...(cwd === undefined ? {} : { cwd }), createdAt: modifiedAt },
})

const localDir = process.cwd()
const localBase = localDir.split(/[\\/]/).filter(Boolean).pop() ?? 'cwd'
const foreignDir = 'P:\\elsewhere'

const local = at(localDir, 'local', 'Local', 1_000)
const foreign = at(foreignDir, 'foreign', 'Foreign', 2_000)

// Most cases below walk the pre-change start (two columns) and press Tab to
// open the workspace column, so they pin `workspacePane: false`. The setting's
// default-on path has its own case at the top of the scene suite.
const wide = { columns: 120, rows: 20, workspacePane: false }

// Pointer delivery rides the host generation, as the split tests note: the
// 0.9.3 kit's Box swallows onWheel into its style bag (its own wheel surfaces
// bypass Box), so wheel routing to plugin handlers only exists on 0.10+ — the
// 0.13.0/0.16.1 host-matrix legs run the wheel cases below.
const generation10 = hasTerminalImageHooks(hostUi)
/** One SGR wheel report; button 64 = wheel up, 65 = wheel down. */
const wheelAt = (col: number, row: number, button: number): string => `\u001b[<${button};${col};${row}M`

describe('splitGeometry with the workspace column', () => {
  it('keeps the two-column numbers exactly when the column is closed', () => {
    expect(splitGeometry(99, true)).toEqual({ split: false, workspaceWidth: 0, listWidth: 99, paneWidth: 0 })
    expect(splitGeometry(120)).toEqual({ split: true, workspaceWidth: 0, listWidth: 70, paneWidth: 50 })
  })

  it('carves the workspace width out of the session list, not the reader', () => {
    // 120 columns: 20% -> 24 for the workspace column; the reader keeps the
    // same 50 columns the two-column layout gives it, so Tab never reflows
    // the conversation being read.
    expect(splitGeometry(120, true)).toEqual({
      split: true,
      workspaceWidth: 24,
      listWidth: 46,
      paneWidth: 50,
    })
    expect(splitGeometry(160, true)).toEqual({
      split: true,
      workspaceWidth: 30,
      listWidth: 74,
      paneWidth: 56,
    })
  })

  it('always fills the viewport exactly', () => {
    for (let columns = 100; columns <= 220; columns++) {
      const geometry = splitGeometry(columns, true)
      expect(geometry.workspaceWidth + geometry.listWidth + geometry.paneWidth, `${columns} columns`).toBe(columns)
      expect(geometry.workspaceWidth).toBeGreaterThanOrEqual(20)
      expect(geometry.workspaceWidth).toBeLessThanOrEqual(30)
    }
  })
})

describe('buildWorkspaces', () => {
  it('pins all sessions on top with the full count', () => {
    const rows = buildWorkspaces([local, foreign])
    expect(rows[0]).toMatchObject({ key: ALL_WORKSPACES_KEY, cwd: undefined, count: 2 })
    expect(rows).toHaveLength(3)
  })

  it('groups sessions by cwd and sorts the groups by recency', () => {
    const olderLocal = at(localDir, 'older', 'Older', 500)
    const rows = buildWorkspaces([olderLocal, local, foreign])
    expect(rows.map(row => row.cwd)).toEqual([undefined, foreignDir, localDir])
    expect(rows.find(row => row.cwd === localDir)?.count).toBe(2)
    expect(rows.find(row => row.cwd === foreignDir)?.count).toBe(1)
  })

  it('counts every session the row would list, not just its own cwd', () => {
    // Picking a row runs the search core's same-workspace rule
    // (sessionCwdMatches), which reaches parent/child directories too, so an
    // exact-cwd tally would print a number the middle column never shows
    // (REVIEW R-181). Phrased against the core itself so the two cannot drift.
    const parentDir = 'D:\\repo'
    const childDir = 'D:\\repo\\sub'
    const parent = at(parentDir, 'parent', 'Parent', 1_000)
    const child = at(childDir, 'child', 'Child', 2_000)
    const rows = buildWorkspaces([parent, child])
    for (const cwd of [parentDir, childDir]) {
      const listed = [parent, child].filter(session => sessionCwdMatches(cwd, session.header.cwd ?? ''))
      expect(listed, cwd).toHaveLength(2)
      expect(rows.find(row => row.cwd === cwd)?.count, cwd).toBe(listed.length)
    }
  })

  it('keeps the live cwd and the current selection visible without sessions', () => {
    // A cwd the configured repo scope points at still needs a row to
    // highlight on the next open, even before any session exists there.
    const rows = buildWorkspaces([], [localDir])
    expect(rows.map(row => row.key)).toEqual([ALL_WORKSPACES_KEY, workspaceKeyOf(localDir)])
    expect(rows[1]?.count).toBe(0)
  })

  it('puts cwd-less sessions in the all-sessions row only', () => {
    const orphan = at(undefined, 'orphan', 'Orphan', 3_000)
    const rows = buildWorkspaces([orphan, local])
    expect(rows).toHaveLength(2)
    expect(rows[0]?.count).toBe(2)
  })

  it('keeps the POSIX root distinct from the all-sessions row (R-186)', () => {
    // '/' used to normalize to '' — the all-sessions row's key — so the root
    // produced a duplicate key (two highlighted rows) and its own count/list
    // disagreed with the core, which treated the empty cwd as "unrecorded".
    expect(workspaceKeyOf('/')).toBe('/')
    expect(workspaceKeyOf('//')).toBe('/')
    expect(workspaceDisplayLabel('/')).toBe('/')
    expect(workspaceShortLabel('/')).toBe('/')
    const root = at('/', 'root', 'Root', 1_000)
    const rows = buildWorkspaces([root])
    expect(rows.map(row => row.key)).toEqual([ALL_WORKSPACES_KEY, '/'])
    expect(rows[1]).toMatchObject({ cwd: '/', count: 1 })
  })

  it('resolves the same workspace through slashes and a trailing separator', () => {
    // Both spellings are the row's stable key: the list must not split one
    // workspace into two after a host update changes the recorded separator.
    if (process.platform !== 'win32') return
    const slashed = at(localDir.replace(/\\/g, '/'), 'slashed', 'Slashed', 1_500)
    const rows = buildWorkspaces([local, slashed])
    expect(rows).toHaveLength(2)
    expect(rows[1]?.count).toBe(2)
  })

  it('spells a workspace the way the scene shows it', () => {
    expect(workspaceDisplayLabel(undefined)).toBe('All sessions')
    expect(workspaceDisplayLabel(foreignDir)).toBe('P:/elsewhere')
    const home = process.env['HOME'] || process.env['USERPROFILE'] || ''
    if (home !== '') {
      const underHome = `${home}${process.platform === 'win32' ? '\\' : '/'}code`
      expect(workspaceDisplayLabel(underHome).startsWith('~')).toBe(true)
    }
  })
})

describe('the workspace row layout and highlight', () => {
  it('sizes a page from the viewport lines, not from entries', () => {
    // The column's viewport budget is in LINES and a workspace row now spends
    // two of them: a ten-line page is five entries, not ten (R-182).
    expect(workspacePageEntries(10)).toBe(5)
    expect(workspacePageEntries(13)).toBe(6)
    expect(workspacePageEntries(1)).toBe(1)
    expect(workspacePageEntries(0)).toBe(1)
  })

  it('fills the selection block only while the column holds the keyboard', () => {
    // Unfocused, the selected row keeps its TEXT highlight (the pointer, the
    // bold suggestion-coloured name) and drops the fill, so it does not read
    // as a second focus next to the session list's selected row (the 10-21
    // real-machine report).
    expect(workspaceRowBackground(true, false, false)).toBeUndefined()
    expect(workspaceRowBackground(true, true, false)).toBe('selectionBg')
    // Hover is a transient pointer affordance, never a selection change.
    expect(workspaceRowBackground(false, false, true)).toBe('userMessageBackgroundHover')
    expect(workspaceRowBackground(true, true, true)).toBe('selectionBg')
  })

  it('keeps the text emphasis and drops the fill on an unfocused selection', async () => {
    const entries = buildWorkspaces([local, foreign])
    const render = async (focused: boolean) =>
      mountKitComponent(
        React.createElement(WorkspaceList, {
          React,
          ui: hostUi,
          entries,
          selectedKey: workspaceKeyOf(foreignDir),
          focused,
          width: 24,
          height: 10,
          onSelect: () => undefined,
          onWheel: () => undefined,
        }),
        { columns: 40, rows: 14 },
      )
    const unfocused = await render(false)
    try {
      const frame = unfocused.rawLatest()
      expect(hasBackground(frame)).toBe(false)
      const nameStyle = firstGlyphStyle(frame, 'elsewhere')
      expect(nameStyle).not.toBe('')
      const focused = await render(true)
      try {
        expect(hasBackground(focused.rawLatest())).toBe(true)
        // Only the row's fill moves with the keyboard: the name keeps the
        // same text styling in both states.
        expect(firstGlyphStyle(focused.rawLatest(), 'elsewhere')).toBe(nameStyle)
      } finally {
        focused.unmount()
      }
    } finally {
      unfocused.unmount()
    }
  })
})

describe('the workspace column in the scene', () => {
  it('opens with the workspace column expanded by default (workspacePane)', async () => {
    // The setting defaults ON: split opens three columns with no key press,
    // and Tab collapses the column for the rest of the mount.
    const harness = await mount(local, {
      columns: 120,
      rows: 20,
      query: '',
      defaultScope: 'all',
      scanner: { scan: async () => [local, foreign] },
    })
    try {
      await waitForMatch(() => harness.all(), /Foreign/)
      await waitForMatch(() => harness.all(), /Workspaces/)
      harness.resize(121, 20)
      await waitFor()
      const pane = workspaceColumn(harness.latest())
      expect(pane).toMatch(/Workspaces/)
      expect(pane).toMatch(/❯\s*All\s*sessions/)
      // The range is the visible carrier itself: every workspace has a row.
      expect(pane).toMatch(new RegExp(escapeRegExp(localBase)))
      expect(pane).toMatch(/P:\/elsewhere/)
      // The session list still shows every session.
      expect(harness.latest()).toMatch(/Local/)
      expect(harness.latest()).toMatch(/Foreign/)

      // Tab still collapses it (the in-scene toggle is unchanged).
      harness.send('\t')
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(workspaceColumn(harness.latest())).not.toMatch(/Workspaces/)
    } finally {
      harness.dispose()
    }
  })

  it('expands with Tab and starts on all sessions when defaultScope is all', async () => {
    const harness = await mount(local, {
      ...wide,
      query: '',
      defaultScope: 'all',
      scanner: { scan: async () => [local, foreign] },
    })
    try {
      await waitForMatch(() => harness.all(), /Foreign/)
      expect(harness.latest()).not.toMatch(/❯\s*All\s*sessions/)
      harness.send('\t')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      const pane = workspaceColumn(harness.latest())
      expect(pane).toMatch(/Workspaces/)
      expect(pane).toMatch(/❯\s*All\s*sessions/)
      // The column lists every workspace of the sweep, the current one included.
      expect(pane).toMatch(new RegExp(escapeRegExp(localBase)))
      expect(pane).toMatch(/P:\/elsewhere/)
      // The session list still searches everything.
      expect(harness.latest()).toMatch(/Local/)
      expect(harness.latest()).toMatch(/Foreign/)
      // Tab collapses the column again.
      harness.send('\t')
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(harness.latest()).not.toMatch(/❯\s*All\s*sessions/)
    } finally {
      harness.dispose()
    }
  })

  it('draws each workspace as a name line above its path line', async () => {
    // The /resume row shape: the name answers "which workspace", the path
    // beneath it answers "where is it". "All sessions" has no path and stays
    // a single line, so the first workspace's name line follows it directly.
    const harness = await mount(local, {
      ...wide,
      query: '',
      defaultScope: 'all',
      scanner: { scan: async () => [foreign, local] },
    })
    try {
      await waitForMatch(() => harness.all(), /Foreign/)
      harness.send('\t')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      const lines = workspaceColumn(harness.latest()).split(/\r\n|\r|\n/)
      const nameAt = lines.findIndex(line => line.includes('elsewhere'))
      expect(nameAt).toBeGreaterThanOrEqual(0)
      // The name line carries the name and the row's count, never the path...
      expect(lines[nameAt]).not.toContain('/')
      // ...and the path sits directly beneath it.
      expect(lines[nameAt + 1]).toMatch(/^\s*P:\/elsewhere/)
      // The one-line all-sessions row is followed by a workspace name line,
      // not by a blank "path" line.
      const allAt = lines.findIndex(line => /All\s*sessions/.test(line))
      expect(allAt).toBeGreaterThanOrEqual(0)
      expect(lines[allAt + 1]).toMatch(/elsewhere/)
    } finally {
      harness.dispose()
    }
  })

  it('starts on the current workspace when defaultScope is repo, and switches live', async () => {
    const harness = await mount(local, {
      ...wide,
      query: '',
      defaultScope: 'repo',
      scanner: { scan: async () => [local, foreign] },
    })
    try {
      await waitForMatch(() => harness.all(), /Local/)
      // The repo scope hides the foreign workspace's sessions.
      expect(harness.latest()).not.toMatch(/Foreign/)
      harness.send('\t')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      const pane = workspaceColumn(harness.latest())
      expect(pane).toMatch(/Workspaces/)
      expect(pane).toMatch(new RegExp(`❯\\s*.*${escapeRegExp(localBase)}`))
      expect(pane).toMatch(/All\s*sessions/)

      // ← focuses the column; ↑ walks to the newer foreign workspace and the
      // middle column follows immediately (selection is the apply step).
      harness.send('\u001b[D')
      await waitFor()
      harness.send('\u001b[A')
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/Foreign/)
      expect(harness.latest()).not.toMatch(/Local/)
      expect(harness.latest()).toMatch(/P:\/elsewhere/)
      // The switch is silent: the column's marker and the filtered list are
      // the feedback, not a transient "Scope: ..." line.
      expect(harness.latest()).not.toMatch(/Scope:/)

      // ↑ again lands on the all-sessions row: both sessions are back.
      harness.send('\u001b[A')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/Local/)
      expect(harness.latest()).toMatch(/Foreign/)
      expect(harness.latest()).toMatch(/❯\s*All\s*sessions/)
      expect(harness.latest()).not.toMatch(/Scope:/)

      // Enter hands the keyboard back to the list: typing edits the query
      // instead of being swallowed by the workspace column.
      harness.send('\r')
      await waitFor()
      harness.send('z')
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/⌕\s*z/)
    } finally {
      harness.dispose()
    }
  })

  it('toggles the column while the reader holds the keyboard', async () => {
    // Tab is handled before the mode branches: it must keep working from the
    // reader, not be swallowed as an inert preview key.
    const harness = await mount(local, {
      ...wide,
      query: '',
      defaultScope: 'all',
      scanner: { scan: async () => [local] },
    })
    try {
      await waitForMatch(() => harness.all(), /Read-only\s*preview/)
      harness.send('\u001b[C')
      await waitFor()
      harness.send('\t')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(workspaceColumn(harness.latest())).toMatch(/Workspaces/)
      expect(harness.latest()).toMatch(/back\s*to\s*list/)
      harness.send('\t')
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(workspaceColumn(harness.latest())).not.toMatch(/Workspaces/)
    } finally {
      harness.dispose()
    }
  })

  it('keeps the classic Tab scope switch when the split is off', async () => {
    // Below the width gate there is no workspace column to expand; Tab keeps
    // its old job there (the no-regression contract for narrow terminals).
    const harness = await mount(local, {
      columns: 90,
      rows: 20,
      query: '',
      defaultScope: 'repo',
      scanner: { scan: async () => [local, foreign] },
    })
    try {
      await waitForMatch(() => harness.all(), /Local/)
      expect(harness.latest()).not.toMatch(/Foreign/)
      harness.send('\t')
      await waitFor()
      harness.resize(91, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/Scope\s*switched\s*to\s*"All\s*sessions"/)
      expect(harness.latest()).toMatch(/Foreign/)
    } finally {
      harness.dispose()
    }
  })

  it('spells the classic range in words on the card and the empty hint (R-187)', async () => {
    // Classic only toggles repo/all: a workspace path on its search card
    // invented a third state, while its empty hint already said "This repo" —
    // one screen, two names for one range.
    const harness = await mount(local, {
      columns: 90,
      rows: 20,
      query: '',
      layout: 'classic',
      defaultScope: 'repo',
      scanner: { scan: async () => [local] },
    })
    try {
      await waitForMatch(() => harness.all(), /Local/)
      harness.resize(91, 20)
      await waitFor()
      const card =
        harness.latest().split(/\r\n|\r|\n/).find(line => line.includes('⌕')) ?? ''
      // The host frame drops padding spaces, so words can arrive concatenated.
      expect(card).toMatch(/Type\s*to\s*search\s*·\s*This\s*repo/)
      expect(card).not.toContain(workspaceDisplayLabel(localDir))

      // A query with no hits reaches the empty-state hint: the same words.
      harness.send('zzz')
      await waitFor()
      harness.resize(90, 20)
      await waitFor()
      const hint =
        harness.latest().split(/\r\n|\r|\n/).find(line => /Scope\s*is/.test(line)) ?? ''
      expect(hint).toMatch(/Scope\s*is\s*"This\s*repo"/)
      expect(harness.latest()).not.toContain(workspaceDisplayLabel(localDir))
    } finally {
      harness.dispose()
    }
  })
})

describe('the three-column layout regressions', () => {
  it('swallows Tab in the classic full-screen preview instead of switching scope', async () => {
    // Below the width gate Tab still flips the range from the LIST; the
    // classic preview is read-only and owns no range key, so a Tab there used
    // to swap the conversation being read out from under the user (R-180).
    const harness = await mount(local, {
      columns: 90,
      rows: 20,
      query: '',
      layout: 'classic',
      defaultScope: 'all',
      // The list order is the scanner's own (an override scanner is not
      // re-sorted), so the foreign session sits on row 0 and the preview
      // opens on it.
      scanner: { scan: async () => [foreign, local] },
    })
    try {
      // The list's own title cells can arrive as a diff that skips them (the
      // harness's tear note), so the PREVIEW is the first reliable paint: the
      // mode switch repaints the whole screen. Alt+P before the sweep has
      // delivered a row is a no-op, so it is pressed again until the reader
      // paints (a second press inside the preview is inert).
      await waitFor(300)
      for (let attempt = 0; attempt < 3 && !/needle\s*foreign/.test(harness.all()); attempt++) {
        harness.send('\u001bp')
        await waitForMatch(() => harness.all(), /needle\s*foreign/, 1_000)
      }
      // The classic preview opens on row 0's conversation (the foreign one).
      expect(harness.all()).toMatch(/needle\s*foreign/)
      harness.send('\t')
      await waitFor()
      // The preview is read-only: it never swaps to the other workspace's
      // conversation, so 'needle local' never reaches the screen.
      expect(harness.all()).not.toMatch(/needle\s*local/)
      // Esc lands back on a list that still searches both sessions.
      harness.send('\u001b')
      await waitFor()
      harness.resize(90, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/Foreign/)
      expect(harness.latest()).toMatch(/Local/)
      expect(harness.latest()).not.toMatch(/Scope\s*switched/)
    } finally {
      harness.dispose()
    }
  })

  it('keeps the classic list fill after a narrow crossing strands the workspace mode (R-191)', async () => {
    // Split hands the keyboard to the workspace column (←), and a resize across
    // the 100-column gate then renders classic with `mode === 'workspace'`
    // left behind (the strand R-180 accepts). Classic has no workspace surface:
    // the list is the only operable pane and still takes ↑↓, so it must paint
    // its selection fill instead of leaving a screen with no focus cue at all.
    const harness = await mount(local, {
      ...wide,
      query: '',
      defaultScope: 'all',
      scanner: { scan: async () => [local, foreign] },
    })
    try {
      await waitForMatch(() => harness.all(), /Local/)
      harness.send('\t')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(workspaceColumn(harness.latest())).toMatch(/Workspaces/)
      harness.send('\u001b[D')
      await waitFor()
      // Cross the gate: the workspace column disappears, the list stays.
      harness.resize(80, 20)
      await waitFor()
      harness.resize(81, 20)
      await waitFor()
      const frame = harness.rawLatest()
      // The selected card's marker carries the fill (the styling is only in
      // the raw stream); asserting the run is non-empty keeps this honest.
      const marker = glyphStyle(frame, '❯')
      expect(marker).not.toBe('')
      expect(hasBackground(marker)).toBe(true)
    } finally {
      harness.dispose()
    }
  })

  it('pages the workspace column by its own viewport, not the list height', async () => {
    // 20 rows: the session list gets 13, while the bordered column can show 10
    // (two border rows plus the title). A page that borrowed the list's 13
    // overshoots by three rows (R-182), and a page counted in ENTRIES rather
    // than lines would jump twice as far as the two-line rows allow: the page
    // is five entries, landing on proj09.
    const dirs = Array.from({ length: 14 }, (_, index) => `D:\\proj${String(index).padStart(2, '0')}`)
    const sessions = dirs.map((cwd, index) => at(cwd, `s${index}`, `S${index}`, 1_000 + index))
    const harness = await mount(sessions[0]!, {
      ...wide,
      query: '',
      defaultScope: 'all',
      scanner: { scan: async () => sessions },
    })
    try {
      // The session list's own cells can arrive as a diff that skips them, so
      // the newly painted COLUMN is the reliable signal: the oldest workspace
      // appearing means every session has arrived and the rows are complete.
      await waitFor(300)
      harness.send('\t')
      await waitForMatch(() => harness.all(), /proj13/, 2_000)
      expect(harness.all()).toMatch(/proj13/)
      harness.send('\u001b[D')
      await waitFor()
      harness.send('\u001b[6~')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      const pane = workspaceColumn(harness.latest())
      // Newest first: proj13 sits directly under "All sessions"; a five-entry
      // page from there lands on proj09.
      expect(pane).toMatch(/❯\s*.*proj09/)
      expect(pane).not.toMatch(/❯\s*.*proj04/)
    } finally {
      harness.dispose()
    }
  })

  it('keeps the selected workspace row inside the viewport, path line included (R-192)', async () => {
    // The column's scroll window is fitted in PHYSICAL LINES: every workspace
    // spends two (name + path). Ten entries down from "All sessions" leaves
    // the selection on proj04, and both of its lines must stay inside the
    // ten-line viewport — fitting on one line per entry scrolls an entry short
    // and cuts the selected row in half, leaving the current range invisible.
    const dirs = Array.from({ length: 14 }, (_, index) => `D:\\proj${String(index).padStart(2, '0')}`)
    const sessions = dirs.map((cwd, index) => at(cwd, `s${index}`, `S${index}`, 1_000 + index))
    const harness = await mount(sessions[0]!, {
      ...wide,
      query: '',
      defaultScope: 'all',
      scanner: { scan: async () => sessions },
    })
    try {
      await waitFor(300)
      harness.send('\t')
      await waitForMatch(() => harness.all(), /proj13/, 2_000)
      harness.send('\u001b[D')
      await waitFor()
      for (let step = 0; step < 10; step++) {
        harness.send('\u001b[B')
        await waitFor()
      }
      harness.resize(121, 20)
      await waitFor()
      const lines = workspaceColumn(harness.latest()).split(/\r\n|\r|\n/)
      const nameAt = lines.findIndex(line => /❯\s*.*proj04/.test(line))
      expect(nameAt).toBeGreaterThanOrEqual(0)
      // The path line sits directly beneath the name line and must be on
      // screen too, not clipped at the viewport's bottom edge.
      expect(lines[nameAt + 1]).toMatch(/^\s*D:\/proj04/)
    } finally {
      harness.dispose()
    }
  })

  it('keeps the tail of a long workspace path on the search card', async () => {
    // A deep workspace: every shallow path in its tree shares the head, so the
    // card's placeholder must cut the HEAD and keep the last segment — the
    // same rule the column's own rows follow (R-183).
    const deepDir = `D:\\${'prefix-segment'.repeat(3)}\\${'middle-segment'.repeat(2)}\\named-tail`
    const deep = at(deepDir, 'deep', 'Deep', 1_000)
    const harness = await mount(deep, {
      columns: 100,
      rows: 20,
      workspacePane: false,
      query: '',
      defaultScope: 'all',
      scanner: { scan: async () => [deep] },
    })
    try {
      // The freshly painted column is the reliable signal (the session list's
      // cells can arrive as a diff that skips them): the deep workspace's row
      // carries the tail of its path.
      await waitFor(300)
      harness.send('\t')
      await waitForMatch(() => harness.all(), /named-tail/, 2_000)
      expect(harness.all()).toMatch(/named-tail/)
      // A resize repaints the whole frame: the column's own lines can arrive
      // as a diff, and latest() anchors on the last painted frame.
      harness.resize(101, 20)
      await waitFor()
      // The path line underneath the name keeps the tail too (a shallow path
      // is all head, so the column could otherwise never tell two deep
      // workspaces with the same name apart).
      const lines = workspaceColumn(harness.latest()).split(/\r\n|\r|\n/)
      const nameAt = lines.findIndex(line => line.includes('named-tail'))
      expect(nameAt).toBeGreaterThanOrEqual(0)
      expect(lines[nameAt + 1]).toContain('…')
      expect(lines[nameAt + 1]).toContain('named-tail')
      harness.send('\u001b[D')
      await waitFor()
      // ↓ from "All sessions" lands on the deep workspace, which the card
      // then names (selection is the apply step).
      harness.send('\u001b[B')
      await waitFor()
      harness.resize(100, 20)
      await waitFor()
      const card =
        harness.latest().split(/\r\n|\r|\n/).find(line => line.includes('⌕')) ?? ''
      expect(card).toContain('named-tail')
      expect(card).toContain('…')
    } finally {
      harness.dispose()
    }
  })

  it('fits the split empty-result hint label to the session column (R-188)', async () => {
    // The hint renders inside the session list (46 columns at 120), but its
    // label was budgeted on the full viewport: a deep path was cut mid-word
    // across four lines. The hint now names the workspace by its short tail,
    // bounded by the column it actually lives in.
    const deepDir = `D:\\${'middle-segment'.repeat(2)}\\named-tail`
    const deep = at(deepDir, 'deep', 'Deep', 1_000)
    const harness = await mount(deep, {
      columns: 120,
      rows: 20,
      workspacePane: false,
      query: 'zzz-nothing',
      defaultScope: 'all',
      scanner: { scan: async () => [deep] },
    })
    try {
      await waitFor(300)
      harness.send('\t')
      await waitFor()
      harness.send('\u001b[D')
      await waitFor()
      // ↓ from "All sessions" selects the deep workspace, whose empty result
      // set is what paints the hint.
      harness.send('\u001b[B')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      const list = listColumn(harness.latest())
      expect(list).toMatch(/Scope\s*is\s*"named-tail"/)
      expect(list).not.toContain('middle-segment')
      const hintLines = list.split(/\r\n|\r|\n/).filter(line => line.trim() !== '')
      // One line for the range, at most one wrapped tail — not the four-line
      // mid-token cut the review recorded.
      expect(hintLines.length).toBeLessThanOrEqual(2)
    } finally {
      harness.dispose()
    }
  })
})

describe.skipIf(!generation10)('the workspace column answers the wheel', () => {
  it('walks the selection by one notch and applies the landed row', async () => {
    // The one surface a pointer-only user had to reach for the keyboard to
    // drive: the wheel now travels the column exactly like the session list's
    // (area-local, the host's ±3 rows per notch, clamped) and the landed row
    // applies, because selecting IS applying here (decision §2.6).
    const dirs = Array.from({ length: 6 }, (_, index) => `D:\\proj${index}`)
    const sessions = dirs.map((cwd, index) => at(cwd, `s${index}`, `S${index}`, 1_000 + index))
    const harness = await mount(sessions[0]!, {
      ...wide,
      fullscreen: true,
      query: '',
      defaultScope: 'all',
      scanner: { scan: async () => sessions },
    })
    try {
      await waitFor(300)
      harness.send('\t')
      // The column's own paint is the settle signal (the session list's cells
      // can arrive as a diff that skips them): the OLDEST workspace row only
      // appears once the sweep has delivered every session.
      await waitForMatch(() => harness.all(), /proj0\b/, 2_000)
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/❯\s*All\s*sessions/)

      // One notch over the column: col 12 sits inside the 24-column pane, row
      // 8 is a body row (border 5 / title 6 / first row 7). Rows are
      // [all, proj5, proj4, proj3, ...], so the host's ±3 lands on proj3 and
      // the scope follows it with no keyboard focus involved.
      harness.send(wheelAt(12, 8, 65))
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      const walked = harness.latest()
      expect(walked).toMatch(/❯\s*.*proj3/)
      // The middle column really switched: only proj3's session is listed.
      expect(walked).toMatch(/S3\b/)
      expect(walked).not.toMatch(/S5\b/)
      expect(walked).not.toMatch(/Scope:/)

      // Three ↓ presses reach the same row from the top — which is what "one
      // notch = three rows" means. ← focuses the column first.
      harness.send('\u001b[D')
      await waitFor()
      harness.send('\u001b[A\u001b[A\u001b[A')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/❯\s*All\s*sessions/)
      harness.send('\u001b[B\u001b[B\u001b[B')
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/❯\s*.*proj3/)
      expect(harness.latest()).not.toMatch(/Scope:/)
    } finally {
      harness.dispose()
    }
  }, 20_000)

  it('clamps at the top instead of wrapping to the last workspace', async () => {
    const dirs = Array.from({ length: 6 }, (_, index) => `D:\\proj${index}`)
    const sessions = dirs.map((cwd, index) => at(cwd, `s${index}`, `S${index}`, 1_000 + index))
    const harness = await mount(sessions[0]!, {
      ...wide,
      fullscreen: true,
      query: '',
      defaultScope: 'all',
      scanner: { scan: async () => sessions },
    })
    try {
      await waitFor(300)
      harness.send('\t')
      await waitForMatch(() => harness.all(), /proj0\b/, 2_000)
      harness.resize(121, 20)
      await waitFor()
      // The notch really moves (the clamp assertion below would otherwise be
      // vacuous): three rows in from "All sessions" is proj3.
      harness.send(wheelAt(12, 8, 65))
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/❯\s*.*proj3/)
      // Back out to the top, then one notch past it: ↑↓ clamp there, and so
      // must the wheel — wrapping would land on the LAST row (the live cwd,
      // which has no sessions) and empty the list.
      harness.send(wheelAt(12, 8, 64))
      await waitFor()
      harness.send(wheelAt(12, 8, 64))
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      const clamped = harness.latest()
      expect(clamped).toMatch(/❯\s*All\s*sessions/)
      expect(clamped).toMatch(/S5\b/)
    } finally {
      harness.dispose()
    }
  }, 20_000)
})

describe('the workspace column answers the pointer', () => {
  it('applies a row on click and hands the keyboard back to the list', async () => {
    // The click path REVIEW 10-20 recorded as real-machine-only: a workspace
    // row click is the whole action (select = apply) plus the focus handoff,
    // so the next keystroke edits the query instead of being swallowed.
    const harness = await mount(local, {
      ...wide,
      fullscreen: true,
      query: '',
      defaultScope: 'all',
      scanner: { scan: async () => [foreign, local] },
    })
    try {
      await waitFor(300)
      harness.send('\t')
      await waitForMatch(() => harness.all(), /Workspaces/, 2_000)
      harness.resize(121, 20)
      await waitFor()
      // Rows are [all, foreign, local] (MRU first); terminal row 7 is the
      // column's first body row, so row 8 is the foreign workspace.
      harness.clickAt(12, 8)
      await waitFor()
      harness.resize(120, 20)
      await waitFor()
      const clicked = harness.latest()
      expect(clicked).toMatch(/❯\s*.*elsewhere/)
      expect(clicked).toMatch(/Foreign/)
      expect(clicked).not.toMatch(/Local/)
      // Selecting a workspace applies the scope silently.
      expect(clicked).not.toMatch(/Scope:/)
      // The keyboard is back on the session list.
      harness.send('z')
      await waitFor()
      harness.resize(121, 20)
      await waitFor()
      expect(harness.latest()).toMatch(/⌕\s*z/)
      expect(harness.latest()).toMatch(/❯\s*.*elsewhere/)
    } finally {
      harness.dispose()
    }
  }, 20_000)
})
