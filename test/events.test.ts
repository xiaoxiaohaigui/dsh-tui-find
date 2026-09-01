/**
 * Extraction sanitization tests — indexed text must carry no terminal-control
 * characters (a raw ESC/BEL in a message body would be written to the
 * terminal verbatim by the scene: escape injection, up to an OSC 52 clipboard
 * overwrite), while the newlines the preview pane needs survive.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXTRACT_OPTIONS, extractLine, newExtractState } from '../src/core/events.js'

const ESC = '\u001B'
const BEL = '\u0007'
const C1 = '\u009F'

describe('extractLine sanitization', () => {
  it('strips terminal control bytes from user message text', () => {
    const state = newExtractState()
    extractLine(
      state,
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: {
          content: [{ type: 'text', text: `先看 ${ESC}[31mred${ESC}[0m${BEL} 再看` }],
          source: { kind: 'user' },
        },
      },
      DEFAULT_EXTRACT_OPTIONS,
    )
    // The ESC is gone; the CSI payload degrades to inert visible text.
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]!.text).toBe('先看 [31mred[0m 再看')
  })

  it('folds CR and tab to printable whitespace and keeps newlines', () => {
    const state = newExtractState()
    extractLine(
      state,
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: {
          content: [{ type: 'text', text: 'a\r\nb\tc\vd\ne' }],
          source: { kind: 'user' },
        },
      },
      DEFAULT_EXTRACT_OPTIONS,
    )
    // CRLF → \n (the preview's line structure survives), tab → space, VT (Cc)
    // dropped, plain \n untouched.
    expect(state.messages[0]!.text).toBe('a\nb cd\ne')
  })

  it('sanitizes assistant text and drops a message that is control bytes only', () => {
    const state = newExtractState()
    extractLine(
      state,
      {
        type: 'assistant/message',
        seq: 1,
        time: 1,
        data: { message: { role: 'assistant', content: [{ type: 'text', text: `${ESC}${C1}${BEL}\u0000` }] } },
      },
      DEFAULT_EXTRACT_OPTIONS,
    )
    extractLine(
      state,
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          message: { role: 'assistant', content: [{ type: 'text', text: `ok ${C1}end` }] },
        },
      },
      DEFAULT_EXTRACT_OPTIONS,
    )
    // A control-only body indexes nothing (it used to index the raw ESC).
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]!.text).toBe('ok end')
  })

  it('strips C1 and DEL from tool summaries (JSON.stringify passes them through)', () => {
    const state = newExtractState()
    extractLine(
      state,
      {
        type: 'tool/call',
        seq: 1,
        time: 1,
        data: { name: 'edit', arguments: { path: `a${C1}b\u007Fc` } },
      },
      { ...DEFAULT_EXTRACT_OPTIONS, indexTools: true },
    )
    expect(state.messages[0]!.text).toBe('[edit] {"path":"abc"}')
  })

  it('sanitizes the header cwd and the session title', () => {
    const state = newExtractState()
    extractLine(
      state,
      { type: 'session', createdAt: 1, cwd: `D:/wo${BEL}rk${ESC}[31m` },
      DEFAULT_EXTRACT_OPTIONS,
    )
    extractLine(
      state,
      { type: 'session/title', data: { title: `fix ${ESC}[31mauth${ESC}[0m` } },
      DEFAULT_EXTRACT_OPTIONS,
    )
    expect(state.header.cwd).toBe('D:/work[31m')
    expect(state.title).toBe('fix [31mauth[0m')
  })

  it('leaves clean text untouched', () => {
    const state = newExtractState()
    extractLine(
      state,
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: {
          content: [{ type: 'text', text: '登录失败重试是不是没加退避？\n换行保留' }],
          source: { kind: 'user' },
        },
      },
      DEFAULT_EXTRACT_OPTIONS,
    )
    expect(state.messages[0]!.text).toBe('登录失败重试是不是没加退避？\n换行保留')
  })
})
