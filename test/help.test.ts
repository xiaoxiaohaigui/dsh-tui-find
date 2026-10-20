/**
 * Help-overlay content tests: the section/row skeleton matches the scene's
 * real key inventory, the keys column is language-free while the action
 * column localizes, and a narrow viewport truncates actions to the row
 * budget instead of letting a row overflow its line.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SHORTCUT } from '../src/config.js'
import { helpSections, keysColumnWidth } from '../src/help.js'
import { setLangOverride, t } from '../src/i18n.js'
import { displayWidth } from '../src/width.js'

afterEach(() => setLangOverride(undefined))

/** Flat key-combo column across every section, in sheet order. */
const allKeys = (sections: ReturnType<typeof helpSections>): string[] =>
  sections.flatMap(section => section.rows.map(row => row.keys))

describe('helpSections', () => {
  it('renders the list / preview / mouse sections in order', () => {
    setLangOverride('en')
    const sections = helpSections(100)
    expect(sections.map(section => section.title)).toEqual([
      t('help-section-list'),
      t('help-section-preview'),
      t('help-section-mouse'),
    ])
  })

  it('carries the full key inventory: 15 list rows, 7 preview rows, 5 mouse rows', () => {
    const sections = helpSections(100, false, DEFAULT_SHORTCUT)
    expect(sections.map(section => section.rows.length)).toEqual([15, 7, 5])
  })

  it('spells the configured global entry and drops it when the entry is off', () => {
    // The sheet lists keys the scene answers: the entry's combo is a real
    // back-out (the scene matches it — see shortcut-combo.ts), so it is
    // spelled as CONFIGURED, and an `off` entry has no combo to spell.
    const remapped = helpSections(100, false, 'ctrl+alt+g')
    expect(allKeys(remapped)).toContain('Ctrl+Alt+G')
    expect(allKeys(remapped)).not.toContain('Alt+F')
    expect(remapped.map(section => section.rows.length)).toEqual([15, 7, 5])

    const off = helpSections(100, false)
    expect(off.map(section => section.rows.length)).toEqual([14, 7, 5])
    expect(allKeys(off)).not.toContain('Alt+F')
  })

  it('describes the global entry as a toggle', () => {
    setLangOverride('en')
    const row = helpSections(100, false, DEFAULT_SHORTCUT)[0]?.rows.find(entry => entry.keys === 'Alt+F')
    expect(row?.action).toMatch(/toggle|open \/ close/i)
  })

  it('marks the row whose key a colliding entry combo has taken (R-160)', () => {
    setLangOverride('en')
    // `shortcut: alt+h` binds the help chord to the entry: the toggle branch
    // wins inside the scene, so the sheet's own Alt+H row must say so — it is
    // the only place a user inside the scene can learn it. The row keeps its
    // key cell (the sheet stays the scene's key inventory) and gains the
    // marker in the action cell.
    const sections = helpSections(100, false, 'alt+h')
    const rows = sections[0]!.rows
    const shadowed = rows.filter(row => row.keys === 'Alt+H')
    // Two rows spell the same combo — the scene's own chord and the global
    // entry's — and only the SHADOWED one is marked. The marker LEADS the
    // action cell: a narrow terminal truncates the tail, and a marker that got
    // cut away would leave the row advertising a key that no longer does it.
    expect(shadowed).toHaveLength(2)
    expect(shadowed[0]!.action).toContain(t('help-shadowed'))
    expect(shadowed[0]!.action.startsWith(t('help-shadowed'))).toBe(true)
    expect(shadowed[1]!.action).not.toContain(t('help-shadowed'))
    expect(shadowed[0]!.action).toMatch(/entry key takes it/i)

    // The marker follows the layout/keys vocabulary too: the scope row is the
    // one the entry takes over at `shortcut: ctrl+tab`.
    const tab = helpSections(100, false, 'ctrl+tab')[0]!.rows.find(row => row.keys === 'Tab')
    expect(tab?.action).toContain(t('help-shadowed'))

    // …and a free combo marks nothing at all.
    const free = helpSections(100, false, DEFAULT_SHORTCUT)
    expect(free.flatMap(section => section.rows).some(row => row.action.includes(t('help-shadowed')))).toBe(false)
    const off = helpSections(100, false)
    expect(off.flatMap(section => section.rows).some(row => row.action.includes(t('help-shadowed')))).toBe(false)

    // A SHIFT-carrying combo marks nothing either (R-164): the toggle matches
    // shift strictly, so `Alt+H` still opens this very sheet. The entry's own
    // row is still listed, spelled the way the config spells it.
    const shifted = helpSections(100, false, 'alt+shift+h')[0]!.rows
    expect(shifted.filter(row => row.keys === 'Alt+H')).toHaveLength(1)
    expect(shifted.some(row => row.keys === 'Alt+Shift+H')).toBe(true)
    expect(shifted.some(row => row.action.includes(t('help-shadowed')))).toBe(false)
  })

  it('keeps the shadow marker on screen when the action itself is truncated', () => {
    setLangOverride('en')
    // 80 columns — the narrow end of a real terminal: the marker plus the Tab
    // row's own copy no longer fit, so the action is cut. The marker must
    // survive that cut: it is the only explanation for a key that does
    // something else now.
    const sections = helpSections(80, false, 'ctrl+tab')
    const row = sections[0]!.rows.find(entry => entry.keys === 'Tab')
    expect(row?.action.startsWith(t('help-shadowed'))).toBe(true)
    expect(row?.action.endsWith('…')).toBe(true)
    // The untouched rows keep their plain copy (no stray marker anywhere else).
    const marked = sections
      .flatMap(section => section.rows)
      .filter(entry => entry.action.includes(t('help-shadowed')))
    expect(marked.map(entry => entry.keys)).toEqual(['Tab'])
  })

  it('keeps the marked rows inside the row budget', () => {
    setLangOverride('zh')
    const columns = 40
    const sections = helpSections(columns, false, 'alt+h')
    const keyWidth = keysColumnWidth(sections)
    const actionBudget = Math.max(1, columns - 2 - keyWidth - 2)
    for (const section of sections) {
      for (const row of section.rows) {
        expect(displayWidth(row.action)).toBeLessThanOrEqual(actionBudget)
      }
    }
  })

  it('keeps the keys column language-free while actions localize', () => {
    setLangOverride('zh')
    const zh = helpSections(100)
    setLangOverride('en')
    const en = helpSections(100)
    expect(allKeys(en)).toEqual(allKeys(zh))
    // The action column must actually follow the language, not the keys.
    expect(en.flatMap(section => section.rows.map(row => row.action))).not.toEqual(
      zh.flatMap(section => section.rows.map(row => row.action)),
    )
  })

  it('spells the key combos the way the scene and hints do', () => {
    setLangOverride('en')
    const keys = allKeys(helpSections(100, false, DEFAULT_SHORTCUT))
    for (const combo of ['<char>', 'Tab', 'Alt+R', 'Alt+T', 'Alt+N', 'Alt+P', 'Alt+C', 'Alt+E', 'Enter', '↑↓', 'PgUp/PgDn', 'Esc', 'Alt+H', 'Alt+F', 'layout', 'n/N', 'Click', '▸ (+N)', 'Hover', 'Wheel']) {
      expect(keys).toContain(combo)
    }
  })

  it('teaches the fold badge in the mouse section', () => {
    // The badge is the one mouse control whose click does NOT do what a click
    // on the row does (that opens the resume confirm), so the sheet must name
    // it — otherwise the mouse user has no way to learn it exists.
    setLangOverride('en')
    const mouse = helpSections(100)[2]
    const fold = mouse?.rows.find(row => row.keys === '▸ (+N)')
    expect(fold?.action).toMatch(/fold|unfold/i)
  })

  it('teaches the split focus arrows and workspace section, and the classic Alt+P open', () => {
    setLangOverride('en')
    // The list section's reader entry is layout-specific: classic opens the
    // full-screen preview with Alt+P, split focuses the always-on pane with
    // →. The preview section's back-out is ← in BOTH layouts (Esc reaches
    // the same place), so only the list entry swaps.
    const classic = allKeys(helpSections(100, false))
    expect(classic).toContain('Alt+P')
    expect(classic).not.toContain('→')
    expect(classic).toContain('←')

    const split = allKeys(helpSections(100, true))
    expect(split).toContain('→')
    expect(split).toContain('←')
    expect(split).not.toContain('Alt+P')
    // Split adds the workspace column's own section (↑↓ / Enter/→ / Tab /
    // Esc); classic has no such column and keeps its original three sections.
    expect(helpSections(100, true).map(section => section.rows.length)).toEqual([14, 4, 7, 5])
    expect(helpSections(100, false).map(section => section.rows.length)).toEqual([14, 7, 5])
    // The workspace section carries the selection vocabulary, and the list
    // section's Tab row describes the column toggle instead of the old scope
    // switch there.
    // list + workspace + preview each carry an ↑↓ row in split.
    expect(split.filter(key => key === '↑↓')).toHaveLength(3)
    expect(split).toContain('Enter/→')
    const splitTab = helpSections(100, true)[0]!.rows.find(row => row.keys === 'Tab')
    expect(splitTab?.action).toBe(t('help-list-workspace'))
    const classicTab = helpSections(100, false)[0]!.rows.find(row => row.keys === 'Tab')
    expect(classicTab?.action).toBe(t('help-list-scope'))
  })

  it('fills every cell at a comfortable width', () => {
    setLangOverride('en')
    const sections = helpSections(120)
    for (const section of sections) {
      expect(section.title.length).toBeGreaterThan(0)
      for (const row of section.rows) {
        expect(row.keys.length).toBeGreaterThan(0)
        expect(row.action.length).toBeGreaterThan(0)
        // Wide viewport: nothing is cut, so no ellipsis may appear.
        expect(row.action.endsWith('…')).toBe(false)
      }
    }
  })

  it('truncates narrow actions into the row budget instead of overflowing', () => {
    setLangOverride('zh')
    const columns = 24
    const sections = helpSections(columns)
    const keyWidth = keysColumnWidth(sections)
    // The overlay's row budget: leading space + keys cell + gutter inside
    // columns - 2 (the scene's row margin), floored at one column.
    const actionBudget = Math.max(1, columns - 2 - keyWidth - 2)
    for (const section of sections) {
      for (const row of section.rows) {
        expect(displayWidth(row.action)).toBeLessThanOrEqual(actionBudget)
        expect(displayWidth(row.action)).toBeGreaterThan(0)
      }
    }
    // And the squeeze is real: something on the sheet had to give.
    expect(sections.some(section => section.rows.some(row => row.action.endsWith('…')))).toBe(true)
  })

  it('survives a degenerate one-column viewport without empty cells', () => {
    setLangOverride('en')
    const sections = helpSections(1)
    for (const section of sections) {
      for (const row of section.rows) {
        expect(row.action.length).toBeGreaterThan(0)
      }
    }
  })

  it('measures the keys column from the widest combo on the sheet', () => {
    setLangOverride('en')
    const sections = helpSections(100)
    expect(keysColumnWidth(sections)).toBe(
      Math.max(...allKeys(sections).map(keys => displayWidth(keys))),
    )
  })
})
