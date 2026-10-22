/**
 * The native-cursor wiring of the full-screen scene's search card.
 *
 * dsh-TUI 0.15.0 gave text inputs the terminal's own caret ("native cursor
 * animation and trails") through the public ui kit: `useDeclaredCursor` grew a
 * `visible` option, `useNativeCursor` says whether this renderer can show it,
 * and a scene receives that whole kit as `props.ui`. Two behaviours follow, and
 * both are pinned here through that same seam:
 *
 * - the terminal's caret only shows while the QUERY owns the keyboard — in
 *   split, the reader and the workspace column take printable keys away from
 *   it, and a native caret pulsing at the search card then would lie;
 * - the painted inverse block stands down exactly where the terminal draws the
 *   caret, and stays where it cannot (older hosts, static output) — the same
 *   static-fallback split the host's own SearchBox and PromptInput use.
 *
 * Stubbing the hooks into the installed kit is what a 0.15.0 host does, so both
 * modes are testable on the 0.9.3 dev baseline (the support matrix carries the
 * real generations).
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

// The painted-caret assertions read SGR 7 off the raw stream, and chalk strips
// escapes off-TTY: turn colours on BEFORE this file's imports, i.e. before
// chalk resolves FORCE_COLOR at module load. Every other assertion here reads
// the declaration (no ANSI at all).
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1'
})

import * as hostUi from '../node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ui.js'
import { setLangOverride } from '../src/i18n.js'
import type { HostCursorOptions } from '../src/vendor/host-cursor.js'
import { hasInverse, mount, sessionWithMessages, waitUntil } from './harness.js'

setLangOverride('en')
afterAll(() => setLangOverride(undefined))

/** The kit a 0.15.0 host hands a scene: the installed ui module plus the two
 *  cursor hooks, with every declaration recorded. */
function cursorKit(native: boolean): { ui: typeof hostUi; calls: HostCursorOptions[] } {
  const calls: HostCursorOptions[] = []
  const ui = {
    ...hostUi,
    useDeclaredCursor: (options: HostCursorOptions) => {
      calls.push(options)
      return () => {}
    },
    useNativeCursor: () => native,
  } as unknown as typeof hostUi
  return { ui, calls }
}

/** The query is `needle` (the harness seed) at 80 columns: `⌕ ` plus the tail,
 *  relative to the bordered box: border + padding + prefix = 4. */
const CARET_COLUMN = 10

describe('scene search card on a native-cursor host (0.15.0+)', () => {
  it('lets the terminal draw the caret instead of painting a block', async () => {
    const { ui, calls } = cursorKit(true)
    const harness = await mount(sessionWithMessages(['needle one', 'second']), { ui })
    try {
      expect(calls.at(-1)).toMatchObject({ line: 1, column: CARET_COLUMN, active: true, visible: true })
      // The only inverse block an /find frame ever paints is the caret: with
      // the terminal owning it, reverse video must not appear at all.
      expect(hasInverse(harness.raw())).toBe(false)
    } finally {
      harness.dispose()
    }
  })

  it('hides it again while the reader owns the keyboard', async () => {
    const { ui, calls } = cursorKit(true)
    // Split (the default layout) needs the width gate: 120 columns.
    const harness = await mount(sessionWithMessages(['needle one', 'second']), { ui, columns: 120, rows: 20 })
    try {
      expect(calls.at(-1)).toMatchObject({ visible: true })
      // → moves the keyboard into the reader pane; printable keys still reach
      // the query only from the list, so the native caret has no job here.
      harness.send('\u001b[C')
      await waitUntil(() => calls.at(-1)?.visible === false)
      expect(calls.at(-1)).toMatchObject({ line: 1, active: true, visible: false })
      expect(hasInverse(harness.raw())).toBe(false)
    } finally {
      harness.dispose()
    }
  })
})

describe('scene search card on a host without a native caret', () => {
  it('keeps the painted block and never asks for a visible caret', async () => {
    const { ui, calls } = cursorKit(false)
    const harness = await mount(sessionWithMessages(['needle one', 'second']), { ui })
    try {
      // 0.13.0/0.14.x and static output: the same declaration parks the cursor
      // for the IME, but the caret itself stays a painted cell.
      expect(calls.at(-1)).toMatchObject({ line: 1, column: CARET_COLUMN, active: true, visible: false })
      expect(hasInverse(harness.raw())).toBe(true)
    } finally {
      harness.dispose()
    }
  })
})
