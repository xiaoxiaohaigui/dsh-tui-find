/**
 * The split layout's leftmost column: the workspace switcher, plus the pure
 * model it renders from.
 *
 * The scene's search range used to be a two-state toggle (this repo / every
 * session). The three-column layout makes it a LIST instead: "all sessions"
 * on top, then one row per workspace seen in the scanned sessions (plus the
 * live cwd, so the configured repo scope always has a row to highlight).
 * Picking a row sets the search's repo scope to that workspace; picking the
 * first row drops the scope back to all sessions. The search core's own
 * `sessionCwdMatches` semantics are reused untouched, so a workspace row
 * means exactly what the repo scope has always meant (same cwd, its
 * descendants, and the resumed-into-subdirectory inverse).
 *
 * The model here is pure and host-free so it can be unit-tested without a
 * renderer; `WorkspaceList` is the one presenter and follows the reader
 * pane's frame vocabulary (round border, permission colour, dim while the
 * pane is not focused) so the three columns read as one generation.
 *
 * Mouse wiring follows the session list's: a click applies the row and hands
 * the keyboard back, the wheel walks the selection by the host's own notch
 * step (area-local — it does not need the keyboard, exactly like the list's
 * wheel), and hover only tints. Hover deliberately stops short of moving the
 * selection here: in this column selecting IS applying, so a pointer merely
 * passing over it would switch the search scope and rebuild the list under
 * the user.
 *
 * @module dsh-tui-find/find-workspaces
 */
import { homedir } from 'node:os'
import type React from 'react'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import { t } from './i18n.js'
import { sessionCwdMatches } from './core/search.js'
import type { ScannedSession } from './core/scan.js'
import { displayWidth, fitScrollWindow, tailWidth, truncateWidth } from './width.js'
import {
  selectionMarker,
  type ClickEventLike,
  type RowUi,
  type WheelBoxProps,
  type WheelEventLike,
} from './find-types.js'

/** One row of the workspace list. `key` is the row's stable identity: the
 *  normalized workspace path, or '' for the "all sessions" row — the same id
 *  the scene's `workspace` state resolves through {@link workspaceKeyOf}. */
export interface WorkspaceEntry {
  /** Stable identity (see above). */
  readonly key: string
  /** The workspace as the host recorded it; undefined on the all-sessions row
   *  (the display label is `t('scope-all')`, resolved at render time so a
   *  language switch repaints it). */
  readonly cwd: string | undefined
  /** Sessions that call this workspace home (all sessions on the first row). */
  readonly count: number
  /** Newest session modification behind the row, the recency sort key. */
  readonly modifiedAt: number
}

/** The row key of the all-sessions entry. */
export const ALL_WORKSPACES_KEY = ''

/** Fixed chrome rows of the workspace column: top + bottom border (2) and the
 *  title row (1). The list viewport gets the content row's height minus these;
 *  PgUp/PgDn derive their entry step from the same viewport budget through
 *  {@link workspacePageEntries} (R-182, and the two-line rows). */
export const WORKSPACE_CHROME_LINES = 3

/** Physical lines one WORKSPACE row spends: a workspace gets the name line
 *  (the segment that names it, plus the row's count on the right) and the path
 *  line beneath it. The all-sessions row has no path of its own and stays a
 *  single line. The scroll window is fitted in these units, so the path line
 *  can never push the selected row out of the viewport (the list's own
 *  card/hit-row discipline, see fitScrollWindow). */
export const WORKSPACE_ROW_LINES = 2

/** Physical lines one workspace entry spends — see {@link WORKSPACE_ROW_LINES}. */
function workspaceRowLines(entry: WorkspaceEntry): number {
  return entry.cwd === undefined ? 1 : WORKSPACE_ROW_LINES
}

/**
 * Entries one PgUp/PgDn moves in the workspace column. The column's viewport
 * is measured in LINES, while the scene's workspace selection is an entry
 * index: a page of bodyHeight lines is about half that many two-line rows.
 * The one-line all-sessions row can make this an entry off at the top, and
 * moveWorkspace clamps at both ends anyway.
 */
export function workspacePageEntries(bodyHeight: number): number {
  return Math.max(1, Math.floor(bodyHeight / WORKSPACE_ROW_LINES))
}

/**
 * Normalize a workspace path to the vocabulary the rows share: forward
 * slashes, no trailing slash. A root spelled only with separators (`/`,
 * `//`) stays `/` instead of collapsing to the empty string: the empty
 * string is the all-sessions row's key, while the POSIX root is a real
 * workspace (R-186). A drive root keeps its `C:\` -> `C:` spelling.
 *
 * Control characters are dropped before anything else. The live cwd is
 * echoed to the terminal WITHOUT passing through `events.ts`'s
 * `sanitizeText` (only log-derived text does), so a directory name carrying
 * ESC/BEL/C1 would otherwise reach `<Text>` and inject terminal sequences
 * (R-200). No legitimate path contains one.
 */
function normalizeWorkspacePath(cwd: string): string {
  // `\p{Cc}` mirrors sanitizeText's set; a path keeps none of it, newline
  // included. `String.prototype.trim` would leave most control characters in
  // place, so this runs before the trim.
  const slashed = cwd.replace(/\p{Cc}/gu, '').trim().replace(/\\/g, '/')
  const normalized = slashed.replace(/\/+$/, '')
  return normalized === '' && slashed.startsWith('/') ? '/' : normalized
}

/**
 * Normalize a cwd to its row identity: forward slashes, no trailing slash,
 * case folded where the platform's filesystem folds it — the same comparison
 * `sessionCwdMatches` makes, so two spellings of one workspace never split
 * into two rows.
 */
export function workspaceKeyOf(cwd: string | undefined): string {
  if (cwd === undefined) return ALL_WORKSPACES_KEY
  const normalized = normalizeWorkspacePath(cwd)
  if (normalized === '') return ALL_WORKSPACES_KEY
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** The home directory in the cwd display vocabulary (precomputed: this runs
 *  once per row on every frame). */
const HOME = homedir().replace(/\\/g, '/').replace(/\/+$/, '')

/**
 * A workspace's display label: `~` for the home directory (and anything under
 * it, the host browser's own shortening), forward slashes, no trailing slash.
 * The all-sessions row resolves through the language dictionary.
 */
export function workspaceDisplayLabel(cwd: string | undefined): string {
  if (cwd === undefined || cwd.trim() === '') return t('scope-all')
  const normalized = normalizeWorkspacePath(cwd)
  if (normalized === '') return t('scope-all')
  const folded = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  const home = process.platform === 'win32' ? HOME.toLowerCase() : HOME
  if (HOME !== '' && home !== '' && (folded === home || folded.startsWith(`${home}/`))) {
    const rest = normalized.slice(HOME.length)
    return rest === '' ? '~' : `~${rest}`
  }
  return normalized
}

/**
 * A workspace's short display label: the segment that names it (the same
 * tail the column's own rows keep). Places whose width cannot afford a path
 * use this instead — the split layout's empty-result hint renders inside the
 * session list's column, not across the viewport (R-188). The all-sessions
 * row keeps its own words.
 */
export function workspaceShortLabel(cwd: string | undefined): string {
  const label = workspaceDisplayLabel(cwd)
  if (cwd === undefined || label === t('scope-all')) return label
  const cut = label.lastIndexOf('/')
  return cut === -1 ? label : label.slice(cut + 1) || '/'
}

/**
 * The workspace rows for the current sweep, most-recently-used first, with
 * the all-sessions row pinned on top.
 *
 * Every cwd recorded by a scanned session becomes one row; `ensureCwds` adds
 * rows that must stay visible even without a session (the live cwd the
 * configured repo scope points at, and the current selection while a sweep
 * is still streaming). A cwd-less session belongs to "all sessions" only.
 */
export function buildWorkspaces(
  sessions: readonly ScannedSession[],
  ensureCwds: readonly (string | undefined)[] = [],
): WorkspaceEntry[] {
  interface Group {
    cwd: string
    count: number
    modifiedAt: number
  }
  const groups = new Map<string, Group>()
  let newest = 0
  for (const session of sessions) {
    if (session.modifiedAt > newest) newest = session.modifiedAt
    const cwd = session.header.cwd
    if (cwd === undefined || cwd.trim() === '') continue
    const key = workspaceKeyOf(cwd)
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, { cwd, count: 1, modifiedAt: session.modifiedAt })
    } else {
      existing.count += 1
      if (session.modifiedAt > existing.modifiedAt) existing.modifiedAt = session.modifiedAt
    }
  }
  for (const cwd of ensureCwds) {
    if (cwd === undefined || cwd.trim() === '') continue
    const key = workspaceKeyOf(cwd)
    if (!groups.has(key)) groups.set(key, { cwd, count: 0, modifiedAt: 0 })
  }
  // A row's count is what selecting it LISTS, i.e. the search core's own
  // same-workspace rule, not an exact-cwd tally: that rule also reaches
  // parent/child directories (the host's /resume semantics — decision §5),
  // so a bare tally would print a number the middle column never shows
  // (R-181). Two distinct workspaces can only match along one path line (one
  // is a '/'-separated ancestor of the other; exact matches are each group's
  // own count), so walking the ancestors of every group key finds every
  // matching pair once — and each candidate is confirmed by the CORE's
  // predicate, keeping the container rules (drive roots, home, UNC roots) in
  // one place instead of a second matcher here. Walking keys rather than
  // every session x workspace pair is what keeps a sweep's flush cheap: the
  // pairwise form measures ~0.9 us per test, i.e. tens of milliseconds per
  // flush at a few hundred sessions and workspaces.
  const counts = new Map<string, number>()
  for (const [key, group] of groups) counts.set(key, group.count)
  for (const [key, group] of groups) {
    for (let at = key.lastIndexOf('/'); at > 0; at = key.lastIndexOf('/', at - 1)) {
      const ancestorKey = key.slice(0, at)
      const ancestor = groups.get(ancestorKey)
      if (ancestor === undefined) continue
      // The ancestor row lists this group's sessions...
      if (sessionCwdMatches(ancestor.cwd, group.cwd)) {
        counts.set(ancestorKey, counts.get(ancestorKey)! + group.count)
      }
      // ...and the resumed-into-subdirectory inverse lists the ancestor's.
      if (sessionCwdMatches(group.cwd, ancestor.cwd)) {
        counts.set(key, counts.get(key)! + ancestor.count)
      }
    }
  }
  const workspaces: WorkspaceEntry[] = [...groups.entries()].map(([key, group]) => ({
    key,
    cwd: group.cwd,
    count: counts.get(key)!,
    modifiedAt: group.modifiedAt,
  }))
  // Recency is what a workspace switcher usually needs ("the one I was just
  // in"); the path tie-break keeps the order deterministic while a sweep
  // delivers equal timestamps.
  workspaces.sort((a, b) => b.modifiedAt - a.modifiedAt || a.key.localeCompare(b.key))
  return [
    { key: ALL_WORKSPACES_KEY, cwd: undefined, count: sessions.length, modifiedAt: newest },
    ...workspaces,
  ]
}

/**
 * The background a workspace row paints. Selection alone does not fill the
 * row: only the column that holds the keyboard shows the selection block, so
 * the screen never carries two "focus" blocks at once (the session list's own
 * selected row is the other one — the 10-21 real-machine report). An
 * unfocused selection keeps its TEXT highlight instead (marker, bold
 * suggestion-coloured name). Hover is a transient pointer affordance and
 * never moves the selection, so it tints even a selected row while the column
 * is unfocused.
 */
export function workspaceRowBackground(
  selected: boolean,
  focused: boolean,
  hovered: boolean,
): 'selectionBg' | 'userMessageBackgroundHover' | undefined {
  if (selected && focused) return 'selectionBg'
  return hovered ? 'userMessageBackgroundHover' : undefined
}

/**
 * The workspace column. Pure display: `selectedKey` and `focused` come from
 * the scene, hover/scroll are local (the FoldBadge precedent — a flag that
 * dies with the row it belongs to). A click selects immediately; the scene
 * owns what "select" means for the search and returns the keyboard to the
 * session list. The wheel rides the same root box as the wheel of the session
 * list and the reader pane, so one notch anywhere over the column moves the
 * selection the way ↑↓ would.
 *
 * Rows follow the /resume browser's two-line shape: the first line answers
 * "which workspace" (its own short name, the focus marker and the session
 * count), the second answers "where is it" (the full path, dim, tail-kept).
 * The all-sessions row has no path and stays one line.
 */
export function WorkspaceList(props: {
  React: TuiSceneProps['React']
  ui: RowUi
  entries: readonly WorkspaceEntry[]
  /** {@link ALL_WORKSPACES_KEY} or a normalized workspace path. */
  selectedKey: string
  /** Whether this pane holds the keyboard: the frame undims and the selected
   *  row is allowed its fill (see {@link workspaceRowBackground}). */
  focused: boolean
  /** Total column width, border included. */
  width: number
  /** Height available to the whole column, border and title included. */
  height: number
  onSelect: (entry: WorkspaceEntry) => void
  /** One wheel event anywhere over the column: the scene moves the selection
   *  by the event's own row count (the host's ±3 per notch), and the range
   *  follows because selecting IS applying. */
  onWheel: (event: WheelEventLike) => void
}): React.ReactElement {
  const { React: R, ui, entries, selectedKey, focused, width, height, onSelect, onWheel } = props
  const { Box, Text } = ui
  // The wheel prop only survives the host Box from the 0.10 kit on (see
  // WheelBoxProps); the session list and the reader cast theirs the same way.
  const WheelBox = Box as unknown as React.ComponentType<WheelBoxProps>
  const { useState, useMemo } = R
  const [hovered, setHovered] = useState<string | undefined>(undefined)
  const [scroll, setScroll] = useState(0)
  const index = useMemo(() => {
    const found = entries.findIndex(entry => entry.key === selectedKey)
    return found === -1 ? 0 : found
  }, [entries, selectedKey])
  const weights = useMemo(() => entries.map(workspaceRowLines), [entries])
  // Border and title rows; what is left is the list viewport.
  const bodyHeight = Math.max(1, height - WORKSPACE_CHROME_LINES)
  const view = useMemo(
    () => fitScrollWindow(weights, index, bodyHeight, scroll),
    [weights, index, bodyHeight, scroll],
  )
  if (view.start !== scroll) setScroll(view.start)
  // Border (2) + paddingX 1 per side.
  const interior = Math.max(1, width - 4)
  return (
    <WheelBox
      flexDirection="column"
      width={width}
      flexShrink={0}
      overflow="hidden"
      borderStyle="round"
      borderColor="permission"
      borderDimColor={!focused}
      paddingX={1}
      onWheel={onWheel}
    >
      <Box flexShrink={0}>
        <Text color="remember" bold>
          {truncateWidth(t('workspace-title'), interior)}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {entries.slice(view.start, view.end).map(entry => {
          const selected = entry.key === selectedKey
          const hoveredRow = hovered === entry.key
          const background = workspaceRowBackground(selected, focused, hoveredRow)
          const countText = String(entry.count)
          const countWidth = displayWidth(countText)
          // Name line: marker (2) + count + one gap cell; the name keeps the
          // rest. Path line: the marker's two cells are the indent, and the
          // path loses its HEAD — its tail is what tells two workspaces apart.
          const nameBudget = Math.max(1, interior - 2 - countWidth - 1)
          const pathBudget = Math.max(1, interior - 2)
          const name = workspaceShortLabel(entry.cwd)
          const path = entry.cwd === undefined ? undefined : workspaceDisplayLabel(entry.cwd)
          return (
            <Box
              key={entry.key === ALL_WORKSPACES_KEY ? '__all__' : entry.key}
              flexDirection="column"
              flexShrink={0}
              width={interior}
              overflow="hidden"
              {...(background === undefined ? {} : { backgroundColor: background })}
              onClick={(event: ClickEventLike) => {
                event.stopImmediatePropagation()
                onSelect(entry)
              }}
              onMouseEnter={() => setHovered(entry.key)}
              onMouseLeave={() => setHovered(undefined)}
            >
              <Box flexDirection="row" flexShrink={0} width={interior} justifyContent="space-between">
                <Box flexDirection="row" flexShrink={1} overflow="hidden">
                  <Text color={selected ? 'suggestion' : 'subtle'}>{selectionMarker(selected)}</Text>
                  <Text color={selected ? 'suggestion' : 'text'} bold={selected}>
                    {truncateWidth(name, nameBudget)}
                  </Text>
                </Box>
                <Text dimColor={!selected}>{countText}</Text>
              </Box>
              {path !== undefined && (
                <Box flexDirection="row" flexShrink={0} width={interior} overflow="hidden">
                  <Text dimColor>{`  ${tailWidth(path, pathBudget)}`}</Text>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    </WheelBox>
  )
}
