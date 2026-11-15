/**
 * The composer `@` completion provider (src/mention.ts): what a row says, what
 * it inserts, how the budgets are spent, and when the index runs a pass.
 *
 * The seam itself is dsh-TUI 0.20.1+ and the dev type baseline is 0.9.3, so
 * the unit tests drive the plugin's own halves (pure item building + the
 * index/registration posture against a stub surface). The real host class is
 * mounted in the matrix legs, where the seam exists.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context as Ctx } from '@deepseek-ai/cordis'

import { dict, setLangOverride } from '../src/i18n.js'
import { resolveConfig, type Config } from '../src/config.js'
import type { ScannedSession, SessionScanner } from '../src/core/scan.js'
import {
  buildMentionItems,
  createMentionProvider,
  MentionIndex,
  MENTION_INSERT_CHARS,
  MENTION_LABEL_CELLS,
  MENTION_MAX_ITEMS,
  MENTION_PROVIDER_ID,
  registerMentionProvider,
  MentionRegistration,
  type MentionProvider,
  type MentionSurface,
} from '../src/mention.js'
import { displayWidth } from '../src/width.js'
import { REGISTER_RETRY_DELAY_MS } from '../src/seam.js'

/** One scanned session, minimum shape the search kernel consumes. */
function session(id: string, title: string, texts: readonly string[], cwd = '/repo'): ScannedSession {
  return {
    id,
    title,
    header: { cwd, createdAt: 1 },
    messages: texts.map((text, index) => ({ seq: index, role: 'user' as const, text, at: index })),
    path: `/${id}.jsonl`,
    bytes: 10,
    modifiedAt: 100 + texts.length,
  }
}

describe('buildMentionItems', () => {
  // The inserted sentence is localized; pin the language so the assertions
  // compare against one known string instead of the host machine's.
  beforeEach(() => setLangOverride('en'))
  afterEach(() => setLangOverride(undefined))

  const sessions = [
    session('a', 'Alpha session', ['the needle is here', 'more text']),
    session('b', 'Beta session', ['nothing to see']),
    session('c', 'Gamma needle', ['unrelated body']),
  ]

  it('returns nothing for an empty token so the bare @ stays quiet', () => {
    expect(buildMentionItems(sessions, '', { scope: 'all' })).toEqual([])
    expect(buildMentionItems(sessions, '   ', { scope: 'all' })).toEqual([])
  })

  it('lists only the sessions that match, in the kernel order', () => {
    const items = buildMentionItems(sessions, 'needle', { scope: 'all' })
    expect(items.map(item => item.label)).toEqual(['Alpha session [a]', 'Gamma needle [c]'])
  })

  it('labels a titleless session with its id instead of an empty row', () => {
    const untitled = session('sess-x', '', ['needle here'])
    const items = buildMentionItems([untitled], 'needle', { scope: 'all' })
    expect(items).toHaveLength(1)
    // The id IS the label here; appending the [id] suffix would print it twice.
    expect(items[0]!.label).toBe('sess-x')
  })

  it('inserts plain words: no @ token, no body text, bounded length', () => {
    const items = buildMentionItems(sessions, 'needle', { scope: 'all' })
    for (const item of items) {
      expect(item.insertText).not.toContain('@')
      // The matched message body must never ride the popup: that would make
      // a completion row a channel for conversation text.
      expect(item.insertText).not.toContain('the needle is here')
      expect(item.insertText.length).toBeLessThanOrEqual(MENTION_INSERT_CHARS)
      expect(item.insertText).toContain('needle')
    }
    expect(items[0]!.insertText).toBe(
      // The sentence names the session by its TITLE; the [id] suffix belongs
      // to the popup label only.
      dict['mention-insert'].en.replace('{{query}}', 'needle').replace('{{title}}', 'Alpha session'),
    )
  })

  it('keeps the label and detail inside the host cell budgets even for CJK', () => {
    const long = session('long', '很长的会话标题'.repeat(30), ['needle'])
    const items = buildMentionItems([long], 'needle', { scope: 'all' })
    expect(displayWidth(items[0]!.label)).toBeLessThanOrEqual(MENTION_LABEL_CELLS)
    expect(displayWidth(items[0]!.detail ?? '')).toBeLessThanOrEqual(40)
  })

  it('stops at the host row cap instead of searching past what can be shown', () => {
    const many = Array.from({ length: MENTION_MAX_ITEMS + 25 }, (_, index) =>
      session(`s${index}`, `Session ${index}`, ['needle']),
    )
    expect(buildMentionItems(many, 'needle', { scope: 'all' })).toHaveLength(MENTION_MAX_ITEMS)
  })

  it('honors the repo scope: no cwd means no rows, like the scene', () => {
    expect(buildMentionItems(sessions, 'needle', { scope: 'repo' })).toEqual([])
    const scoped = buildMentionItems(sessions, 'needle', { scope: 'repo', repoCwd: '/repo' })
    expect(scoped.map(item => item.label)).toEqual(['Alpha session [a]', 'Gamma needle [c]'])
  })
})

describe('row contracts that the host enforces downstream (R-219/220/221)', () => {
  beforeEach(() => setLangOverride('en'))
  afterEach(() => setLangOverride(undefined))

  it('neutralizes @ so the host does not drop the row as a mention token', () => {
    // The host runs extractMentions(insertText) and DROPS the whole row when
    // it finds a token. A session title is user data and may contain one.
    const risky = session('x', 'please ask @alice about the needle', ['needle here'])
    const items = buildMentionItems([risky], 'needle', { scope: 'all' })
    expect(items).toHaveLength(1)
    // The host's own rule, reproduced: nothing that parses as a mention.
    expect(items[0]!.insertText).not.toMatch(/(^|\s)@[\w-]/u)
    expect(items[0]!.insertText).not.toContain('@alice')
    // …and the sentence still reads (fullwidth at-sign, not deletion).
    expect(items[0]!.insertText).toContain('\uFF20alice')
  })

  it('neutralizes an @ typed into the query too', () => {
    const items = buildMentionItems([session('a', 'Alpha', ['@alice ping needle'])], '@alice needle', { scope: 'all' })
    for (const item of items) expect(item.insertText).not.toContain('@')
  })

  it('bounds insertText in CHARACTERS, the unit the host caps', () => {
    // 90 astral characters: 90 wide cells of a column-budgeted cut is
    // nowhere near 200 UTF-16 units, so a width-based cap overflowed the
    // host limit and the row was dropped (R-220).
    const wide = session('w', '\u{1F680}'.repeat(90), ['needle'])
    const items = buildMentionItems([wide], 'needle', { scope: 'all' })
    expect(items).toHaveLength(1)
    expect(items[0]!.insertText.length).toBeLessThanOrEqual(MENTION_INSERT_CHARS)
  })

  it('keeps two same-titled sessions addressable (distinct rows)', () => {
    // The host dedupes on (label, insertText): identical pairs collapse and
    // one of the two sessions becomes unreachable through @ (R-221).
    const a = session('sess-aaaa1111', 'Weekly sync', ['needle one'])
    const b = session('sess-bbbb2222', 'Weekly sync', ['needle two'])
    const items = buildMentionItems([a, b], 'needle', { scope: 'all' })
    expect(items).toHaveLength(2)
    // The host's dedupe key is (label, insertText) — that pair is what must
    // differ; `detail` is not part of it.
    const keys = items.map(item => `${item.label}\u0000${item.insertText}`)
    expect(new Set(keys).size).toBe(2)
    // The identity rides the LABEL (where the human picks a row), and the
    // inserted sentence stays clean: a short id in a prompt is noise the model
    // cannot resolve — this plugin gives it no reader for the session.
    expect(items[0]!.label).toContain('[sess-aaa]')
    expect(items[1]!.label).toContain('[sess-bbb]')
    expect(items[0]!.insertText).not.toContain('sess-aaa')
    expect(items[1]!.insertText).not.toContain('sess-bbb')
  })

  it('keeps the label inside the host cell budget with the id suffix on', () => {
    // The suffix must be RESERVED before truncating the title: appending it
    // afterwards would overflow the label, the host would cut the TAIL, and
    // the id — the only thing keeping two same-titled rows apart — would be
    // what gets dropped (R-221).
    const long = session('sess-zzzz9999', '很长的会话标题'.repeat(20), ['needle'])
    const items = buildMentionItems([long], 'needle', { scope: 'all' })
    expect(displayWidth(items[0]!.label)).toBeLessThanOrEqual(MENTION_LABEL_CELLS)
    expect(items[0]!.label).toContain('[sess-zzz]')
  })

  it('does not repeat the id when a session has no title', () => {
    const untitled = session('sess-x', '', ['needle here'])
    const items = buildMentionItems([untitled], 'needle', { scope: 'all' })
    expect(items[0]!.label).toBe('sess-x')
    expect(items[0]!.label).not.toContain('[sess-x]')
  })
})
