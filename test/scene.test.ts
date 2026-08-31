import { describe, expect, it } from 'vitest'
import { wheelStep } from '../src/scene.js'

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
