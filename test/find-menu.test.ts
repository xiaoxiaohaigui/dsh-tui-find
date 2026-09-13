/**
 * The context menu's pure model: opening anchors and highlights the first
 * item, highlight movement clamps into the item range, hover points the
 * highlight straight at a row, and activation yields the highlighted entry.
 * The scene wiring (which actions run) is bound at open time; these tests
 * pin the state machine those closures ride.
 */
import { describe, expect, it } from 'vitest'
import { highlightAt, highlightedItem, moveHighlight, openMenu, type MenuItem } from '../src/find-menu.js'

const items: readonly MenuItem[] = [
  { id: 'copy-message', label: 'Copy message text' },
  { id: 'copy-log', label: 'Copy session log path' },
  { id: 'resume', label: 'Resume this session' },
]

describe('openMenu', () => {
  it('anchors at the pointer and highlights the first item', () => {
    const menu = openMenu(12, 5, items)
    expect(menu.anchorCol).toBe(12)
    expect(menu.anchorRow).toBe(5)
    expect(menu.highlight).toBe(0)
    expect(highlightedItem(menu)?.id).toBe('copy-message')
  })
})

describe('moveHighlight', () => {
  it('moves down and up within range', () => {
    let menu = openMenu(0, 0, items)
    menu = moveHighlight(menu, 1)
    expect(highlightedItem(menu)?.id).toBe('copy-log')
    menu = moveHighlight(menu, -1)
    expect(highlightedItem(menu)?.id).toBe('copy-message')
  })

  it('clamps at both ends instead of wrapping', () => {
    let menu = openMenu(0, 0, items)
    menu = moveHighlight(menu, -1)
    expect(highlightedItem(menu)?.id).toBe('copy-message')
    menu = moveHighlight(openMenu(0, 0, items), 10)
    expect(highlightedItem(menu)?.id).toBe('resume')
  })

  it('is inert on an empty menu', () => {
    const menu = openMenu(0, 0, [])
    expect(highlightedItem(menu)).toBeUndefined()
    expect(moveHighlight(menu, 1)).toBe(menu)
  })
})

describe('highlightAt (hover path)', () => {
  it('points the highlight straight at the hovered row', () => {
    let menu = openMenu(0, 0, items)
    menu = highlightAt(menu, 2)
    expect(highlightedItem(menu)?.id).toBe('resume')
    menu = highlightAt(menu, 0)
    expect(highlightedItem(menu)?.id).toBe('copy-message')
  })

  it('ignores out-of-range rows instead of corrupting the state', () => {
    const menu = openMenu(0, 0, items)
    expect(highlightAt(menu, -1)).toBe(menu)
    expect(highlightAt(menu, items.length)).toBe(menu)
  })

  it('is inert on an empty menu', () => {
    const menu = openMenu(0, 0, [])
    expect(highlightAt(menu, 0)).toBe(menu)
  })
})
