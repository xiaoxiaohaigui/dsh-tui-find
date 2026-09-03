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

  it('carries the full key inventory: 13 list rows, 6 preview rows, 3 mouse rows', () => {
    const sections = helpSections(100)
    expect(sections.map(section => section.rows.length)).toEqual([13, 6, 3])
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
    for (const combo of ['<char>', 'Tab', 'Alt+R', 'Alt+T', 'Alt+P', 'Alt+C', 'Alt+E', 'Enter', '↑↓', 'PgUp/PgDn', 'Esc', 'Alt+H', 'Alt+F', 'n/N', 'Click', 'Hover', 'Wheel']) {
      expect(keys).toContain(combo)
    }
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
