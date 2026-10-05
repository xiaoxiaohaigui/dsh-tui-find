/**
 * The sidebar panel: the plugin's search surface inside the host's right
 * column, registered through dsh-TUI 0.13.0's `ctx.tuiPanels` seam.
 *
 * Shape of the thing, and why:
 *
 * - The panel is the SAME single-column list the full-screen scene draws
 *   (find-list.ListView over find-rows.buildRows), with a query line on top
 *   and a status/hint footer. Enter (or a click on the already-selected row)
 *   hands the query and the selected `rowId` to the full-screen scene, which
 *   is where reading a long conversation, copying and resuming live.
 * - Typing works IN the panel, without any host support for text fields: the
 *   sidebar routes plain characters to the active panel's `host.onKey` first
 *   and swallows whatever the panel leaves (useSidePanel: "the right column
 *   owns the keyboard while focused"), so a focused panel is a pure keyboard
 *   surface. Ctrl/Alt chords never arrive (they stay with the host's global
 *   actions), which is why the panel has no regex/title/scope toggles of its
 *   own — it searches with the configured defaults. `pinyin` (default on)
 *   covers what a missing IME caret would otherwise cost: see the note on
 *   `declarePanelCursor`.
 * - The panel component is unmounted whenever another tab is active
 *   (`mountPolicy: 'active'`), so all state lives in FindPanelDriver
 *   (panel-model.ts) and the component only renders it.
 *
 * Seam posture: `ctx.tuiPanels` exists only on 0.13.0+ (the sidebar itself
 * arrived in that release), so it is soft-probed and the panel registers
 * late-mount and boot-window-retry style, exactly like the scene and the
 * warm-up view. On every older host this module does nothing at all.
 *
 * @module dsh-tui-find/panel
 */
import type React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { TuiSceneProps } from '@deepseek-harness-tui/dsh-tui/scenes'
import { t, type I18nKey } from './i18n.js'
import { composeHeaderRight, fitHintLine, HintLine, type HintSegment } from './find-chrome.js'
import { ListView } from './find-list.js'
import { wheelRows, type RowUi } from './find-types.js'
import type { FindPanelDriver } from './panel-model.js'
import { registerSeamWithRetry, whenSeamMounted } from './seam.js'
import { tailWidth, truncateWidth } from './width.js'

/** Panel id: the host namespaces it as `dsh-tui-find:search`. */
export const PANEL_ID = 'search'
/** The panel API generation this module is written against — the host rejects
 *  any other value outright (`TUI_PANEL_API_VERSION`). */
export const PANEL_API_VERSION = 1
/** PanelBar glyph. Display width 1 in the host's own `stringWidth`, which is
 *  what the descriptor validator measures (a 2-cell glyph is rejected). */
export const PANEL_ICON = '⌕'
/** Below this many columns the host shows its "too narrow" notice instead of
 *  mounting the component — the list's own budget assumes roughly this. */
export const PANEL_MIN_COLUMNS = 28
/** PanelBar order: after the builtins (todo 10 · info 15 · jobs 20 ·
 *  trajectory 25 · agents 30 · workspace 35 · companion 40). */
export const PANEL_ORDER = 50
/** The tab title, resolved through t() at registration (the descriptor takes
 *  a literal — plugins have no i18n-key form). */
export const PANEL_TITLE_KEY: I18nKey = 'panel-title-find'

// ── the seam's shapes, structural ────────────────────────────────────────
//
// Local structural types, not vendored host declarations: this plugin builds
// against the 0.9.3 kit, which has no `./panels` subpath at all, and the
// plugin only ever consumes a handful of members (the notify.ts /
// warmup.tsx soft-probe precedent). Anything the host narrows away at the
// type level but still carries at runtime is marked as such.

/**
 * The host's parsed-key flags for a panel, as DECLARED by the seam — plus the
 * three flags the runtime object carries but the declared type omits:
 * `usePanelInput` spreads ink's own key object into the dispatcher
 * (`{...key, return_: true}`), and the host's `input-event.js` sets
 * backspace/delete/tab from the keypress name on the same object. They are
 * read here defensively; the input-string forms below (`\x7f`, `\t`) are the
 * fallback if that spread ever stops carrying them.
 */
export interface PanelKeyFlags {
  readonly escape?: boolean
  readonly leftArrow?: boolean
  readonly rightArrow?: boolean
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly pageUp?: boolean
  readonly pageDown?: boolean
  readonly return_?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
  /** Runtime-only (see above). */
  readonly backspace?: boolean
  readonly delete?: boolean
  readonly tab?: boolean
}

/** `preventDefault()` = consume: the host's fallback keys (←/→ panel cycling,
 *  Esc back to the chat, `z`/digits/`+`/`-`) do not fire. */
export interface PanelKeyEvent {
  readonly input: string
  readonly key: PanelKeyFlags
  preventDefault(): void
}

/** The panel's host API, narrowed to what this panel uses. */
export interface PanelHostApi {
  /** Curated read-only session snapshot (fresh structural copy per call). */
  snapshot(): { readonly sessionId: string; readonly cwd: string }
  /** Only delivered while this panel is focused and visible. */
  onKey(listener: (event: PanelKeyEvent) => void): () => void
}

/** The panel's ui kit: the host's own Box/Text/Divider plus panel-sized
 *  hooks. Box is pointer-only here (no ref, no focus, no keyboard props) —
 *  that is why the query line cannot declare the terminal's IME caret. */
export interface PanelUi extends RowUi {
  readonly Divider: React.ComponentType<{ readonly title?: string }>
  readonly useTerminalSize: () => { readonly columns: number; readonly rows: number }
}

export interface FindPanelProps {
  readonly React: TuiSceneProps['React']
  readonly ui: PanelUi
  readonly host: PanelHostApi
  readonly width: number
  readonly height: number
  readonly focused: boolean
  readonly visible: boolean
  readonly mode: 'split' | 'zoom' | 'fullscreen'
}

/** The probed slice of the 0.13.0+ `TuiPanelRuntime`. Optional members: the
 *  probe's whole point is that an older host has no such service at all. */
interface PanelServiceSurface {
  register?(
    descriptor: {
      readonly apiVersion: number
      readonly id: string
      readonly title: string
      readonly icon?: string
      readonly minColumns?: number
      readonly order?: number
      readonly component: React.ComponentType<FindPanelProps>
    },
    identity?: Context,
  ): (() => void) | undefined
  /** This plugin's own panels, with the FINAL (host-prefixed) ids. */
  list?(): readonly { readonly id: string; readonly title: string }[]
  /** Set/clear a badge on one of this plugin's own panels. */
  badge?(
    id: string,
    badge: { readonly level: 'info' | 'warning' | 'error'; readonly unread: number } | null,
  ): boolean
}

/**
 * The host-assigned final id of this plugin's panel, read back from `list()`
 * (the descriptor's own id is only the suffix). Register namespaces the id
 * with the caller's component identity when the activation carries a verified
 * one, and with a synthesized `act<N>` otherwise — this plugin rides the
 * documented C-070 direct-activation path, so the `<pluginId>:` form in the
 * seam docs is NOT what lands here. Read-only call, wrapped: a liveness-gate
 * rejection just means no badge.
 */
function resolvePanelId(panels: PanelServiceSurface): string | undefined {
  try {
    return panels.list?.().find(entry => entry.id.endsWith(`:${PANEL_ID}`))?.id
  } catch {
    return undefined
  }
}

/**
 * The panel component for one registration attempt.
 *
 * IME note (`declarePanelCursor`): the full-screen search card declares the
 * terminal's cursor so a composing IME draws its preedit inline; the panel kit
 * cannot (its Box type strips `ref`), so an IME preedit may render wherever
 * the host left the cursor. Pinyin search — on by default — is the documented
 * way around it: `denglu` finds 登录 without an IME.
 */
export function buildFindPanelComponent(driver: FindPanelDriver): React.ComponentType<FindPanelProps> {
  const FindPanel = (props: FindPanelProps): React.ReactElement => {
    const { React: R, ui, host, width, height, focused } = props
    const { Box, Text } = ui
    const snapshot = R.useSyncExternalStore(driver.subscribe, driver.getSnapshot)

    // The repo scope's cwd comes from the host's curated snapshot — the same
    // cwd the scene reads off its channel. Memoized per HOST identity: that
    // object changes with the channel (the adapter memoizes it on
    // channel/activity/attention/focused), so the cwd cannot go stale, while
    // the snapshot's frozen object graph is not rebuilt on every progress
    // tick (it is O(session) garbage for one string).
    const cwd = R.useMemo(() => host.snapshot().cwd, [host])
    R.useEffect(() => {
      driver.setRepoCwd(cwd)
    }, [cwd])
    // Mounted === this panel is the active tab: make sure the index is built,
    // and tell the driver when nobody is looking any more (badge instead).
    R.useEffect(() => {
      driver.attach()
      return () => driver.detach()
    }, [])

    // Layout: query line + status line + (divider) + list + (hint). The two
    // optional rows are dropped before the list is squeezed below one row —
    // a 4-row panel still shows results.
    const contentWidth = Math.max(1, width - 2)
    const showDivider = height >= 5
    const showHint = height >= 6
    const listHeight = Math.max(1, height - 2 - (showDivider ? 1 : 0) - (showHint ? 1 : 0))

    // Keyboard (host.onKey): delivered only while focused && visible, and the
    // sidebar swallows every plain key this handler leaves unconsumed — so the
    // handler is a full dispatcher, not an interceptor. `driver.getSnapshot()`
    // rather than the render closure: a key must act on the state a previous
    // key in the same chunk produced (the scene's mirror discipline).
    R.useEffect(
      () =>
        host.onKey(event => {
          const { input, key } = event
          if (key.upArrow === true) {
            driver.move(-1)
            event.preventDefault()
            return
          }
          if (key.downArrow === true) {
            driver.move(1)
            event.preventDefault()
            return
          }
          if (key.pageUp === true) {
            driver.page(-1, listHeight)
            event.preventDefault()
            return
          }
          if (key.pageDown === true) {
            driver.page(1, listHeight)
            event.preventDefault()
            return
          }
          // Delete keys: the flag when the runtime carries it, the raw bytes
          // otherwise (see PanelKeyFlags).
          if (key.backspace === true || key.delete === true || input === '\x7f' || input === '\b') {
            driver.backspace()
            event.preventDefault()
            return
          }
          if (key.return_ === true) {
            // Modifier-free only, the host's #110 rule the scene applies to
            // its own commits (`isPlainReturn`): a shift/ctrl/alt Enter is a
            // different intent and must not take the scene over.
            if (key.ctrl === true || key.meta === true || key.shift === true) return
            driver.openSelected()
            event.preventDefault()
            return
          }
          if (key.escape === true) {
            // Esc clears the query; an empty query is the host's (focus goes
            // back to the chat). Not consuming that one is the whole contract.
            if (driver.getSnapshot().query.length > 0) {
              driver.setQuery('')
              event.preventDefault()
            }
            return
          }
          if (key.tab === true || input === '\t') {
            driver.toggleFold()
            event.preventDefault()
            return
          }
          // Ctrl/Alt chords are never delivered here (the host keeps them for
          // its global actions); defensive only.
          if (key.ctrl === true || key.meta === true) return
          if (input.length > 0) {
            driver.appendInput(input)
            event.preventDefault()
          }
        }),
      [host, listHeight],
    )

    const recentMode = snapshot.query.trim().length === 0
    const hitTotal = snapshot.hits.reduce((sum, hit) => sum + hit.total, 0)
    const status = composeHeaderRight({
      progress: snapshot.progress,
      recentMode,
      sessionCount: snapshot.rows.length,
      hitSessions: snapshot.hits.length,
      hitTotal,
      settledHiddenSubagents: snapshot.hiddenSubagents,
    })
    const emptyText =
      snapshot.phase === 'indexing' || snapshot.phase === 'cold'
        ? t('reading-sessions')
        : recentMode
          ? t('no-sessions')
          : snapshot.regexRejected !== undefined
            ? t(snapshot.regexRejected === 'unsafe' ? 'regex-unsafe' : 'regex-invalid')
            : t('no-results')
    const hintSegments: readonly HintSegment[] = recentMode
      ? [
          { text: t('hint-seg-type'), mandatory: true },
          { text: t('hint-seg-navigate') },
          { text: t('hint-seg-esc') },
        ]
      : [
          { text: t('hint-seg-open'), mandatory: true },
          { text: t('hint-seg-navigate') },
          { text: t('hint-seg-fold') },
          { text: t('hint-seg-esc') },
        ]

    const titleWidth = Math.max(1, Math.min(48, contentWidth - 4))
    const hitWidth = Math.max(1, contentWidth - 4)
    const caret = focused ? <Text inverse>{' '}</Text> : null
    const queryTail = tailWidth(snapshot.query, Math.max(0, contentWidth - 3))

    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={width} flexShrink={0}>
        <Box flexShrink={0}>
          {snapshot.query.length === 0 ? (
            <Text wrap="truncate-end">
              {'⌕ '}
              {caret}
              <Text dimColor>{truncateWidth(t('panel-placeholder'), Math.max(1, contentWidth - 3))}</Text>
            </Text>
          ) : (
            <Text wrap="truncate-end">
              {'⌕ '}
              {queryTail}
              {caret}
            </Text>
          )}
        </Box>
        <Box flexShrink={0}>
          <Text
            wrap="truncate-end"
            {...(snapshot.notice !== undefined ? { color: snapshot.notice.tone === 'error' ? 'error' as const : 'success' as const } : { dimColor: true })}
          >
            {truncateWidth(snapshot.notice?.text ?? status, contentWidth)}
          </Text>
        </Box>
        {showDivider ? <ui.Divider /> : null}
        {snapshot.rows.length === 0 ? (
          <Box height={listHeight} flexShrink={0}>
            <Text dimColor italic wrap="truncate-end">
              {truncateWidth(emptyText.trim(), contentWidth)}
            </Text>
          </Box>
        ) : (
          <ListView
            React={R}
            ui={ui}
            rows={snapshot.rows}
            selected={snapshot.selected}
            height={listHeight}
            titleWidth={titleWidth}
            hitWidth={hitWidth}
            width={contentWidth}
            // Click selects; a click on the row that is already selected opens
            // it — the panel's only pointer path into the scene (Enter is the
            // keyboard one). Hover moves the selection, as in the scene.
            onRowClick={index => {
              if (index === driver.getSnapshot().selected) driver.openSelected()
              else driver.select(index)
            }}
            onRowHover={index => driver.select(index)}
            onRowFold={index => {
              driver.select(index)
              driver.toggleFold()
            }}
            onWheel={event => driver.move(wheelRows(event.deltaY, event.deltaX ?? 0))}
          />
        )}
        {showHint ? (
          <Box flexShrink={0}>
            <Text dimColor italic>
              <HintLine React={R} ui={ui} text={fitHintLine(hintSegments, contentWidth)} />
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  }
  FindPanel.displayName = 'FindPanel'
  return FindPanel
}

/**
 * Register the panel on a host that has the seam, and nothing anywhere else.
 *
 * Both failure shapes the other seams handle are handled the same way here: a
 * service that is absent is a silent no-op, and a registration refused during
 * the host's cold-boot liveness window is retried with the shared bounded
 * budget.
 *
 * The service itself is polled for (`whenSeamMounted`), not just probed once:
 * the TUI's service rows mount independently of this plugin's row — observed
 * on a real boot where `tuiScenes` was missing at apply time — and a miss here
 * would cost the panel for the whole session. The give-up announcement is
 * silenced (`quiet`): on every host before 0.13.0 the absence is the designed
 * state, and a toast about a feature the user never had would be noise.
 */
export function registerFindPanel(ctx: Context, options: { readonly driver: FindPanelDriver }): void {
  whenSeamMounted(
    ctx,
    'find panel',
    () => {
      const panels = ctx.get('tuiPanels', false) as unknown as PanelServiceSurface | undefined
      return panels !== undefined && typeof panels.register === 'function' ? panels : undefined
    },
    panels => {
      const register = (): (() => void) => {
        // Fresh component per attempt: the host keeps the instance it
        // accepted, so a retried registration must not share closure state
        // with a rejected attempt (the warm-up view's rule).
        const dispose = panels.register!(
          {
            apiVersion: PANEL_API_VERSION,
            id: PANEL_ID,
            title: t(PANEL_TITLE_KEY),
            icon: PANEL_ICON,
            minColumns: PANEL_MIN_COLUMNS,
            order: PANEL_ORDER,
            component: buildFindPanelComponent(options.driver),
          },
          ctx,
        )
        // The host REFUSES without throwing (no live plugin activation,
        // duplicate id, exhausted panel budget) and warns internally; surface
        // that as the retry machinery's failure shape.
        if (dispose === undefined) throw new Error('tuiPanels.register refused the find panel')
        return dispose
      }
      try {
        const dispose = register()
        ctx.effect(() => dispose)
        // The driver badges its own panel when a sweep settles with nobody
        // looking; that needs the id the host actually assigned.
        const panelId = resolvePanelId(panels)
        if (panelId !== undefined) {
          options.driver.bindBadge(badge => {
            try {
              panels.badge?.(panelId, badge)
            } catch {
              // Additive: a rejected badge call changes nothing else.
            }
          })
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        // A shadow-mode run denies this capability outright
        // (`dsh-tui: shadow policy denies register in passive-shadow mode`):
        // permanent by construction, not the cold-boot race the retry budget
        // exists for. Retrying would burn ten minutes and then announce a
        // give-up that never was.
        if (detail.includes('shadow policy denies')) {
          ctx.logger.info(`dsh-tui-find: find panel unavailable (${detail})`)
          return
        }
        registerSeamWithRetry(ctx, 'find panel', register, dispose => ctx.effect(() => dispose), error)
      }
    },
    { quiet: true },
  )
}
