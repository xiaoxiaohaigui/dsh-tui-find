import { describe, expect, it } from 'vitest'
import { selectionMarker, wheelStep } from '../src/scene.js'

describe('wheelStep', () => {
  it('moves one row for vertical wheel events', () => {
    expect(wheelStep(1)).toBe(1)
    expect(wheelStep(-1)).toBe(-1)
  })

  it('ignores horizontal-only wheel events', () => {
    expect(wheelStep(0, 1)).toBe(0)
    expect(wheelStep(0, -1)).toBe(0)
  })
})

describe('selectionMarker', () => {
  it('keeps title and message arrows in the same column', () => {
    expect(selectionMarker(true)).toBe('❯ ')
    expect(selectionMarker(false)).toBe('  ')
    expect(selectionMarker(true, 'message')).toBe('❯   ')
    expect(selectionMarker(false, 'message')).toBe('    ')
  })
})
