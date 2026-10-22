/**
 * The frame anchor both mounts share ({@link frameTail}). `latest()` means "the
 * last painted frame", and a frame that paints no text is still a frame the host
 * writes: the panel's IME cursor declaration emits one (hide-cursor + frame head
 * + cursor moves + end) once the real frame is on screen. Anchoring there reads
 * `''` for a component that painted — the CI-only stand-down failure this pins.
 * The byte shapes below are the ones the run 38241257734 diagnostic captured:
 * the panel's cold frame (132 stripped bytes) sat behind exactly such a block,
 * while `latest()` read `''`.
 */
import { describe, expect, it } from 'vitest'
import { frameTail, hasBackground, stripAnsi } from './harness.js'

/** A cold panel frame: sync block, reset + OSC-8 head, then real rows. */
const FRAME = '\u001b[?25l\u001b[?2026h\u001b[0m\u001b]8;;\u0007\u001b[1C\u2315\r\n\u001b[1C0\u001b[1Csessions\r\n\u001b[?2026l'

/** The cursor declaration's frame: the same head, no text at all. */
const TEXTLESS = '\u001b[?25l\u001b[?2026h\u001b[0m\u001b]8;;\u0007\u001b[3C\u001b[16A\u001b[?2026l'

describe('frameTail', () => {
  it('skips a textless trailing block and reads the frame behind it', () => {
    const frame = stripAnsi(frameTail(FRAME + TEXTLESS))
    expect(frame).toMatch(/0\s*sessions/)
    expect(frame).toBe(stripAnsi(FRAME))
  })

  it('keeps a trailing frame that does carry text', () => {
    const settled = FRAME.replace('0\u001b[1Csessions', '1\u001b[1Csession')
    expect(stripAnsi(frameTail(FRAME + settled))).toBe(stripAnsi(settled))
    expect(stripAnsi(frameTail(FRAME + settled))).not.toMatch(/0\s*sessions/)
  })

  it('skips several textless blocks in a row', () => {
    expect(stripAnsi(frameTail(FRAME + TEXTLESS + TEXTLESS))).toBe(stripAnsi(FRAME))
  })

  it('returns the stream as it stands when no frame head is present', () => {
    expect(frameTail('plain text, no head')).toBe('plain text, no head')
  })
})

describe('hasBackground', () => {
  it('ignores a truecolor foreground whose components look like background codes', () => {
    // 102 is an RGB component here, not SGR 102 (bright-green background).
    expect(hasBackground('\u001b[38;2;94;102;115mtext')).toBe(false)
    expect(hasBackground('\u001b[38;2;40;41;42mtext')).toBe(false)
  })

  it('ignores a 256-colour foreground index that reads like a background code', () => {
    // The index is an argument of 38;5, not a standalone SGR 44.
    expect(hasBackground('\u001b[38;5;44mtext')).toBe(false)
  })

  it('sees a truecolor background and its 256-colour form', () => {
    expect(hasBackground('\u001b[48;2;94;102;115mtext')).toBe(true)
    expect(hasBackground('\u001b[48;5;236mtext')).toBe(true)
  })

  it('sees the 8/16-colour fills and ignores the default-background reset', () => {
    expect(hasBackground('\u001b[44mtext')).toBe(true)
    expect(hasBackground('\u001b[100mtext')).toBe(true)
    expect(hasBackground('\u001b[49mtext')).toBe(false)
    expect(hasBackground('\u001b[0mplain')).toBe(false)
  })
})
