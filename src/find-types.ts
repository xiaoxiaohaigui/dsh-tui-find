/**
 * Shared vocabulary of the find scene split (`scene.tsx` + `find-*.tsx`):
 * the row/mode types every module speaks, the layout constants, and the
 * pure string helpers the panes render with. No JSX lives here — types,
 * constants and pure functions only, so the panes and the input hook can
 * import without cycles.
 *
 * @module dsh-tui-find/find-types
 */
import type React from 'react'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import { t } from './i18n.js'
import type { ResolvedConfig } from './config.js'
import type { ScannedSession } from './core/scan.js'
import type { MessageHit, SessionHit } from './core/search.js'

/** The host ui kit's component/hook surface, derived from the scene props. */
export type Ui = TuiSceneProps['ui']
/** The host's parsed-key flags, derived from the ui kit's own useInput. */
export type InputKey = Parameters<Parameters<Ui['useInput']>[0]>[1]
/** The color vocabulary Text accepts (theme keys + raw values). */
export type TextColor = NonNullable<React.ComponentProps<Ui['Text']>['color']>

/**
 * The installed dsh-tui 0.9.3 declarations predate `onWheel`, although its
 * runtime dispatcher already routes wheel events to handler props. Keep the
 * widening local to the find scene instead of weakening the injected ui surface.
 *
 * 0.10+ThemedBox 官方类型已含 onWheel/onContextMenu，本交叉类型对 0.10.1 冗余
 * 但无害（0.9.3 基线必需）；待 peer 下限提升到 >=0.10.0 时退役。
 */
export type WheelEventLike = { readonly deltaY: number; readonly deltaX?: number }
export type WheelBoxProps = React.ComponentProps<Ui['Box']> & {
  onWheel?: (event: WheelEventLike) => void
}

/**
 * The 0.10+ context-menu event, structurally: 0.9.3's Box declarations (and
 * its runtime dispatcher) predate right-click delivery entirely, so the
 * find scene attaches `onContextMenu` only when the generation probe below
 * passes. The real event carries more (modifier bits, button byte); these
 * are the fields the menu needs — absolute pointer cell for anchoring the
 * popup, per-handler local cell for mapping a preview row to its message,
 * and the bubble-stop the item handlers use to keep the backdrop closed.
 */
export type ContextMenuEventLike = {
  readonly col: number
  readonly row: number
  readonly localCol: number
  readonly localRow: number
  stopImmediatePropagation(): void
}
export type ContextBoxProps = React.ComponentProps<Ui['Box']> & {
  onContextMenu?: (event: ContextMenuEventLike) => void
}

export type Mode = 'list' | 'preview' | 'confirm' | 'help'

/** The time window the list and search filter sessions by — the same
 *  vocabulary as the `defaultTime` config knob (its initial value). */
export type TimeFilter = ResolvedConfig['defaultTime']

/** A transient status toast line: text plus the tone that picks its glyph
 *  and colour (✔/✕) in every pane footer. */
export type StatusNote = { text: string; tone: 'info' | 'error' }

/** A row of the flattened list. Every row is selectable — a session card
 *  resumes its session, a hit row resumes the session it hit. A card's
 *  title hit rides INSIDE the card's title line (highlighted there, the
 *  browser's own title treatment) and never as a separate row. A results
 *  card also carries its session's own hit list so Alt+P can open the
 *  reader anchored anywhere and `n`/`N` can walk its hits; recent-mode
 *  cards have no SessionHit and set nothing (exactOptionalPropertyTypes). */
export type FlatRow =
  | { kind: 'session'; session: ScannedSession; titleHit: MessageHit | undefined; hits?: readonly MessageHit[] }
  | { kind: 'message'; hit: SessionHit; message: MessageHit; index: number; more: number }

/** The body shape both copy paths feed copyMessage with: a hit row's
 *  MessageHit and a preview cursor's raw message are structurally the same. */
export type CopyEntry = {
  readonly role: 'user' | 'assistant' | 'tool' | undefined
  readonly text: string
  readonly at: number | undefined
}

/** Vertical chrome of the layout: header + search card (3) + notice +
 *  divider + hints. The list gets whatever remains. */
export const CHROME_LINES = 7
/** Hits shown per session card before `(+N)`. */
export const PREVIEW_HITS = 3
/** Fixed chrome rows of the preview pane: title + meta + log path + status
 *  + hint. The scroll region gets rows minus these; PgUp/PgDn page by the
 *  same. */
export const PREVIEW_CHROME_LINES = 5
/** Terminal width the split layout asks for: at or above it the /find scene
 *  renders the left list and the right reader side by side (the host
 *  browser's own threshold), below it the classic rendering takes over —
 *  a width gate only, no notice, no state. */
export const SPLIT_MIN_COLUMNS = 100
/** Fixed chrome rows of the split reader pane: top + bottom border (2) +
 *  title (1) + meta (1). The scroll region gets the content row's height
 *  minus these; PgUp/PgDn page by the same. */
export const PANE_CHROME_LINES = 4

/** Geometry of the split content row (left list + right reader), mirroring
 *  the host browser's own split arithmetic: the pane caps at 56 columns and
 *  takes 42% of the viewport, the list keeps the rest. Below the width gate
 *  there is no split — the caller renders classic. */
export function splitLayout(columns: number): { split: boolean; listWidth: number; paneWidth: number } {
  if (columns < SPLIT_MIN_COLUMNS) return { split: false, listWidth: Math.max(0, columns), paneWidth: 0 }
  const paneWidth = Math.min(56, Math.floor(columns * 0.42))
  return { split: true, listWidth: Math.max(0, columns - paneWidth), paneWidth }
}
/** First gap between progressive-sweep list flushes, doubling per flush up
 *  to {@link PARTIAL_FLUSH_MAX_MS} — see useSessionSweep for why the gap
 *  grows instead of staying fixed. */
export const PARTIAL_FLUSH_MS = 100
/** Ceiling of the doubling flush gap: the streamed list never goes a whole
 *  second without an update, however long the sweep runs. */
export const PARTIAL_FLUSH_MAX_MS = 800

/** Role glyph and colour for a preview entry, the host preview's vocabulary
 *  (user ❯, assistant ✦) plus a tool marker for tool-call rows. The assistant
 *  colour here is the 0.9-generation brand key `claude`; render sites resolve
 *  the generation-correct key through {@link roleMarkColor} — 0.10 renamed
 *  the same mist blue to `accent`. */
export const ROLE_MARK: Record<'user' | 'assistant' | 'tool', { glyph: string; color: SceneColor }> = {
  user: { glyph: '❯', color: 'suggestion' },
  assistant: { glyph: '✦', color: 'claude' },
  tool: { glyph: '⚙', color: 'warning' },
}

/** Text colour vocabulary extended with the two generation brand keys —
 *  `claude` (0.9.x, the 0.9.3 build baseline's own theme key) and `accent`
 *  (0.10+, renamed in place with identical palette values). Neither key
 *  exists in the other generation's Text vocabulary, so the record's colour
 *  field carries this local union and the render sites resolve it back to
 *  TextColor through {@link roleMarkColor}'s runtime probe. */
type SceneColor = TextColor | 'claude' | 'accent'

/**
 * Whether the injected ui kit is the 0.10 generation: the 0.10 kit ships
 * terminal-image hooks the 0.9 kit never had, and the host passes scenes
 * the full ui module namespace, so the hook's presence is a structural
 * generation marker. Shared by every generation-gated capability (the
 * assistant role colour, the right-click context menu). A wrong probe
 * degrades — an uncoloured role mark, an unattached menu — never a crash.
 */
export function hasTerminalImageHooks(ui: Ui): boolean {
  return typeof (ui as Ui & { useTerminalImages?: unknown }).useTerminalImages === 'function'
}

/**
 * The assistant role's colour, resolved per host generation. 0.10 renamed the
 * mist brand key `claude` → `accent` (identical palette values) and both kits
 * resolve colour props by plain table lookup, so the wrong key renders
 * silently without colour — no error, just a lost tint. The sanctioned
 * surface exposes no palette accessor (`useTheme()` returns the theme NAME on
 * both generations), so the generation is probed structurally off the
 * injected ui kit — see {@link hasTerminalImageHooks}. If that marker is
 * ever absent from a kit that no longer speaks `claude` either, the host
 * lookup degrades to no colour — the chain's dim end.
 */
export function roleMarkColor(ui: Ui, role: 'user' | 'assistant' | 'tool'): TextColor {
  if (role !== 'assistant') return ROLE_MARK[role].color as TextColor
  const accent: SceneColor = 'accent'
  return hasTerminalImageHooks(ui) ? (accent as TextColor) : (ROLE_MARK.assistant.color as TextColor)
}

/**
 * Elapsed time as a person would say it, mirroring the host browser's
 * `formatWhen` thresholds and wording (relative up to a week, then a date).
 */
export function formatWhen(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) return ''
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 45) return t('when-now')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('when-minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('when-hours', { n: hours })
  const days = Math.round(hours / 24)
  if (days <= 7) return t('when-days', { n: days })
  const date = new Date(at)
  return t('when-date', { m: date.getMonth() + 1, d: date.getDate() })
}

/** Title fallback mirroring the host picker: cwd basename, then id prefix. */
export function displayTitle(session: ScannedSession): string {
  if (session.title !== undefined && session.title !== '') return session.title
  const cwd = session.header.cwd ?? ''
  if (cwd !== '') {
    const parts = cwd.split(/[\\/]/)
    const base = parts[parts.length - 1]
    if (base !== undefined && base !== '') return base
  }
  return session.id.slice(0, 8)
}

export function wheelStep(deltaY: number, deltaX = 0): -1 | 0 | 1 {
  if (deltaY === 0 || !Number.isFinite(deltaY) || !Number.isFinite(deltaX)) return 0
  return deltaY > 0 ? 1 : -1
}

/** Selection marker shared by title and message rows. Both arrows occupy the
 * first terminal column, while message rows retain their extra two-cell
 * content indent so the list hierarchy remains visible. */
export function selectionMarker(selected: boolean, row: 'title' | 'message' = 'title'): string {
  if (row === 'message') return selected ? '❯   ' : '    '
  return selected ? '❯ ' : '  '
}
