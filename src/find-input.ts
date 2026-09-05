/**
 * The scene's keyboard dispatcher as a hook: every key the scene owns while
 * open lands here — typing edits the query, Alt+X chords drive scope/time/
 * regex/title-only/preview/copy/expand/help, arrows and pages move, Esc
 * backs out one layer (query, then screen). State arrives through the
 * deps bag: refs the handler reads and keeps fresh (React batches every
 * parsed key from one stdin chunk, so the handler can run several times
 * before a re-render — the host browser's focusRef discipline), functional
 * setters for the position edits, and the shared callbacks. Nothing here
 * renders.
 *
 * @module dsh-tui-find/find-input
 */
import { t } from './i18n.js'
import type { ScannedSession } from './core/scan.js'
import type { SearchScope } from './core/search.js'
import { hitOrdinal, jumpHit, messageAtLine, stepMessage, type PreviewLine } from './preview.js'
import {
  CHROME_LINES,
  PREVIEW_CHROME_LINES,
  type CopyEntry,
  type FlatRow,
  type InputKey,
  type Mode,
  type StatusNote,
  type TimeFilter,
  type Ui,
} from './find-types.js'

/** Only a modifier-free Enter may commit a modal (the host's #110 rule:
 *  Option/Shift/Ctrl+Enter arrive as return+modifier and must not). */
function isPlainReturn(key: InputKey): boolean {
  return key.return === true && !key.ctrl && !key.meta && !key.shift && !key.super
}

/** Everything the dispatcher touches, passed explicitly by FindScene. The
 *  setter/ref types stay structural so the scene's own useState/useRef
 *  values flow in regardless of the host React typings' version. */
export interface FindInputDeps {
  ui: Ui
  modeRef: { current: Mode }
  queryRef: { current: string }
  scopeRef: { current: SearchScope }
  timeFilterRef: { current: TimeFilter }
  useRegexRef: { current: boolean }
  titleOnlyRef: { current: boolean }
  /** Locks the resume pipeline so a repeated Enter cannot start the same
   *  async operation twice before the mode change renders. */
  actionPendingRef: { current: boolean }
  setQuery: (next: string | ((current: string) => string)) => void
  setScope: (next: SearchScope | ((current: SearchScope) => SearchScope)) => void
  setTimeFilter: (next: TimeFilter | ((current: TimeFilter) => TimeFilter)) => void
  setUseRegex: (next: boolean | ((current: boolean) => boolean)) => void
  setTitleOnly: (next: boolean | ((current: boolean) => boolean)) => void
  setMode: (next: Mode | ((current: Mode) => Mode)) => void
  setExpanded: (next: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>)) => void
  setSelected: (next: number | ((current: number) => number)) => void
  setPreviewCursor: (next: number | ((current: number) => number)) => void
  setStatus: (next: StatusNote | undefined | ((current: StatusNote | undefined) => StatusNote | undefined)) => void
  flatLength: number
  rows: number
  selectedRow: FlatRow | undefined
  previewLines: readonly PreviewLine[]
  previewCursor: number
  previewSession: ScannedSession | undefined
  previewHitStarts: readonly number[]
  previewAnchorRef: { current: number | undefined }
  beginResume: () => void
  confirmResume: () => Promise<void>
  copyMessage: (entry: CopyEntry) => void
  copySelected: () => void
  close: () => void
}

export function useFindInput(deps: FindInputDeps): void {
  const {
    ui,
    modeRef,
    queryRef,
    scopeRef,
    timeFilterRef,
    useRegexRef,
    titleOnlyRef,
    actionPendingRef,
    setQuery,
    setScope,
    setTimeFilter,
    setUseRegex,
    setTitleOnly,
    setMode,
    setExpanded,
    setSelected,
    setPreviewCursor,
    setStatus,
    flatLength,
    rows,
    selectedRow,
    previewLines,
    previewCursor,
    previewSession,
    previewHitStarts,
    previewAnchorRef,
    beginResume,
    confirmResume,
    copyMessage,
    copySelected,
    close,
  } = deps
  const { useInput } = ui

  useInput(
    (input: string, key: InputKey) => {
      // Modifier gates. The host reports Alt as key.meta (parse-keypress
      // maps the Windows ALT modifier state onto meta; classic terminals
      // report Alt via the ESC prefix the same way). Single letters must
      // never be intercepted while ctrl/meta/super is held — the host
      // delivers Ctrl+C as input 'c' + key.ctrl, and hijacking that would
      // break the scene's interrupt path.
      const plain = !key.ctrl && !key.meta && !key.super
      const altOnly = key.meta && !key.ctrl && !key.super
      // Letter shortcuts match case-insensitively: Shift+Alt+C arrives as
      // meta + 'C', and the hint lines label the keys as capital letters.
      // The typing path below still consumes the raw input untouched.
      const lower = input.toLowerCase()

      if (key.escape) {
        if (modeRef.current === 'list') {
          if (queryRef.current.length > 0) setQuery('')
          else close()
        } else {
          setMode('list')
        }
        return
      }
      if (modeRef.current === 'confirm') {
        if (isPlainReturn(key) && !actionPendingRef.current) {
          actionPendingRef.current = true
          void confirmResume().finally(() => {
            actionPendingRef.current = false
          })
        }
        return
      }
      if (modeRef.current === 'help') {
        // Alt+H toggles the panel closed (its own row says so); Esc lands in
        // the shared escape branch above. Every other key stays swallowed —
        // the help screen is inert and typing must never leak into the query.
        if (altOnly && lower === 'h') setMode('list')
        return
      }
      if (modeRef.current === 'preview') {
        const lastLine = Math.max(0, previewLines.length - 1)
        if (isPlainReturn(key)) beginResume()
        else if (lower === 'c' && altOnly) {
          // Alt+C copies the message the cursor sits on, whatever line of
          // it (header or body) holds the cursor.
          const entry = previewSession?.messages[messageAtLine(previewLines, previewCursor) ?? 0]
          if (entry !== undefined) copyMessage(entry)
        } else if (key.upArrow) {
          setPreviewCursor(current => stepMessage(previewLines, current, -1))
        } else if (key.downArrow) {
          setPreviewCursor(current => stepMessage(previewLines, current, 1))
        } else if (key.pageUp || key.pageDown) {
          const jump = Math.max(1, rows - PREVIEW_CHROME_LINES)
          setPreviewCursor(current => {
            const next = key.pageUp ? current - jump : current + jump
            return Math.min(lastLine, Math.max(0, next))
          })
        } else if (plain && lower === 'n') {
          // Walk the session's own hits (`n` forward, Shift+n back). A
          // recent-session card has an empty hit table and no-ops silently;
          // a session's hit table is circular, so moving past either end
          // wraps and a non-empty table always yields a target.
          const currentMessage = messageAtLine(previewLines, previewCursor) ?? 0
          const { total } = hitOrdinal(previewHitStarts, currentMessage)
          if (total > 0) {
            const target = jumpHit(previewHitStarts, currentMessage, key.shift ? -1 : 1)!
            setPreviewCursor(target)
            const { index } = hitOrdinal(previewHitStarts, messageAtLine(previewLines, target) ?? 0)
            setStatus({ text: t('preview-hit-jump', { index, total }), tone: 'info' })
          }
        }
        // Every other key stays swallowed: the preview is read-only and
        // typing must never leak back into the query.
        return
      }
      // list mode
      if (key.tab) {
        const next: SearchScope = scopeRef.current === 'repo' ? 'all' : 'repo'
        scopeRef.current = next
        setScope(next)
        setStatus({
          text: t('scope-switched', { scope: next === 'repo' ? t('scope-repo') : t('scope-all') }),
          tone: 'info',
        })
        return
      }
      if (altOnly && lower === 't') {
        // Cycle the time window: 全部 → 近 7 天 → 近 30 天 → 全部.
        const current = timeFilterRef.current
        const next: TimeFilter = current === 'all' ? '7d' : current === '7d' ? '30d' : 'all'
        timeFilterRef.current = next
        setTimeFilter(next)
        setStatus({
          text: t('time-switched', {
            range: t(next === 'all' ? 'time-all' : next === '7d' ? 'time-7d' : 'time-30d'),
          }),
          tone: 'info',
        })
        return
      }
      if (altOnly && lower === 'r') {
        const next = !useRegexRef.current
        useRegexRef.current = next
        setUseRegex(next)
        setStatus({ text: t(next ? 'regex-on' : 'regex-off'), tone: 'info' })
        return
      }
      if (altOnly && lower === 'n') {
        // Title-only matching: a title hit still highlights inside the
        // card's title line; message rows simply stop matching.
        const next = !titleOnlyRef.current
        titleOnlyRef.current = next
        setTitleOnly(next)
        setStatus({ text: t(next ? 'title-only-on' : 'title-only-off'), tone: 'info' })
        return
      }
      if (isPlainReturn(key)) {
        beginResume()
        return
      }
      // Preview/copy/expand live on Alt+P / Alt+C / Alt+E ONLY. Bare letters
      // always type — a bare-key form fought the first keystroke of every
      // query on a real terminal and was removed in v0.1.2. Alt+P works on
      // cards too (preview from the head of the conversation); Alt+C needs a
      // concrete hit, while Alt+E toggles every message hit on the card.
      if (altOnly && lower === 'p') {
        const row = selectedRow
        if (row !== undefined) {
          // Anchor: a hit row parks the cursor on its own message's header
          // line; a card (or a title hit, which has no message) starts from
          // the head of the conversation.
          previewAnchorRef.current = row.kind === 'message' ? (row.message.sourceIndex ?? -1) : -1
          setMode('preview')
        }
        return
      }
      if (altOnly && lower === 'c') {
        copySelected()
        return
      }
      if (altOnly && lower === 'e') {
        const row = selectedRow
        if (row !== undefined) {
          const id = row.kind === 'message' ? row.hit.session.id : row.session.id
          // Recent-mode cards have no hit bundle, so there is nothing to
          // expand. Result cards and their child rows share one session id.
          const hasHits = row.kind === 'message' || (row.hits !== undefined && row.hits.some(entry => entry.kind === 'message'))
          if (!hasHits) return
          setExpanded(current => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
        return
      }
      if (altOnly && lower === 'h') {
        setMode('help')
        return
      }
      if (key.upArrow) {
        setSelected(current => Math.max(0, current - 1))
        return
      }
      if (key.downArrow) {
        setSelected(current => Math.min(Math.max(0, flatLength - 1), current + 1))
        return
      }
      if (key.pageUp || key.pageDown) {
        const jump = Math.max(1, rows - CHROME_LINES)
        setSelected(current => {
          const next = key.pageUp ? current - jump : current + jump
          return Math.min(Math.max(0, flatLength - 1), Math.max(0, next))
        })
        return
      }
      if (key.backspace || key.delete) {
        // Delete a whole CODE POINT — a UTF-16 code-unit slice would leave a
        // lone surrogate behind after backspacing over an emoji.
        setQuery(current => {
          if (current.length === 0) return current
          const characters = [...current]
          characters.pop()
          return characters.join('')
        })
        return
      }
      if (input.length > 0 && plain) {
        // Only real characters reach the query — control bytes inside a
        // paste (newlines included) must not type invisibly.
        const typed = input.replace(/\p{Cc}/gu, '')
        if (typed.length > 0) setQuery(current => current + typed)
      }
    },
    { isActive: true },
  )
}
