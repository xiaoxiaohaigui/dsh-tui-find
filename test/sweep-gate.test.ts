/**
 * The single-sweep slot (sweep-gate.ts): the precedence rules the warm-up and
 * the sidebar panel rely on, pinned without either of them present.
 */
import { describe, expect, it } from 'vitest'
import { SweepGate } from '../src/sweep-gate.js'

describe('sweep gate', () => {
  it('hands the slot to whoever asks first and reports the take to the loser', () => {
    const gate = new SweepGate()
    const warmup = gate.claim('warmup')
    expect(warmup).toBeDefined()
    expect(warmup!.lost()).toBe(false)
    expect(gate.current()).toBe('warmup')

    // The panel outranks the warm-up: its claim lands and the warm-up's hold
    // is revoked — which is how a background sweep learns to abort at its
    // next tick.
    const panel = gate.claim('panel')
    expect(panel).toBeDefined()
    expect(warmup!.lost()).toBe(true)
    expect(panel!.lost()).toBe(false)
    expect(gate.current()).toBe('panel')
  })

  it('refuses the warm-up while the panel holds the slot', () => {
    const gate = new SweepGate()
    const panel = gate.claim('panel')
    expect(panel).toBeDefined()
    // No claim at all: the warm-up's documented behavior is to give up for
    // this activation, not to queue behind a user-facing search.
    expect(gate.claim('warmup')).toBeUndefined()
    expect(gate.current()).toBe('panel')
  })

  it('frees the slot on release so a later claim wins it', () => {
    const gate = new SweepGate()
    const warmup = gate.claim('warmup')
    warmup!.release()
    expect(gate.current()).toBeUndefined()

    const next = gate.claim('warmup')
    expect(next).toBeDefined()
    expect(next!.lost()).toBe(false)
  })

  it('never lets a stale claim release its successor', () => {
    const gate = new SweepGate()
    const warmup = gate.claim('warmup')
    const panel = gate.claim('panel')
    expect(warmup!.lost()).toBe(true)

    // A sweep that settles after being preempted releases through its own
    // claim — that must not free the slot the panel now owns (the failure
    // mode would be a third sweeper starting on top of the panel's).
    warmup!.release()
    expect(gate.current()).toBe('panel')
    expect(panel!.lost()).toBe(false)
    expect(gate.claim('warmup')).toBeUndefined()
  })

  it('re-claiming by the same owner counts as a fresh hold', () => {
    // A driver that restarts its sweep (scene closed, panel re-attached)
    // claims again; the previous claim must not be able to release the new one.
    const gate = new SweepGate()
    const first = gate.claim('panel')
    const second = gate.claim('panel')
    expect(first!.lost()).toBe(true)
    expect(second!.lost()).toBe(false)
    first!.release()
    expect(gate.current()).toBe('panel')
    second!.release()
    expect(gate.current()).toBeUndefined()
  })
})
