/**
 * Help-overlay content tests: the section/row skeleton matches the scene's
 * real key inventory, the keys column is language-free while the action
 * column localizes, and a narrow viewport truncates actions to the row
 * budget instead of letting a row overflow its line.
 */
import { afterEach, describe, expect, it } from 'vitest'
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
    const sections = helpSections(100)
    expect(sections.map(section => section.rows.length)).toEqual([15, 7, 5])
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
    const keys = allKeys(helpSections(100))
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

  it('teaches the focus arrows in split and the Alt+P open in classic', () => {
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
    // Same row counts either way: the vocabulary swaps, the sheet's shape
    // does not.
    expect(helpSections(100, true).map(section => section.rows.length)).toEqual(
      helpSections(100, false).map(section => section.rows.length),
    )
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
