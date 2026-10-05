/**
 * The sidebar panel's state: a plugin-scoped store plus the driver that fills
 * it. Both live outside React on purpose.
 *
 * The host mounts plugin panels with `mountPolicy: 'active'` (panels.ts: the
 * "don't let a resident panel burn resources" rule), so the component is
 * UNMOUNTED every time the user switches to another sidebar tab or collapses
 * the sidebar. Component state would therefore lose the query, the index and
 * the selection on every switch, and the next visit would re-run a sweep.
 * The store is the panel's real state; the component is a view over it, which
 * is also what lets the index outlive a mount (the sweep keeps streaming into
 * the store while the panel is not on screen).
 *
 * The driver owns three things the scene owns internally for its own surface:
 *
 * - the sweep (one per activation, lazily on first attach), on the SAME
 *   plugin-scoped scanner the warm-up and the scene use, so every decode it
 *   pays for is a decode the others do not;
 * - the search derivation (find-rows.ts), so the rows the panel shows are the
 *   rows the scene will show after a handoff;
 * - the single-sweep slot (sweep-gate.ts), where a panel sweep outranks the
 *   background warm-up and yields to the full-screen scene.
 *
 * @module dsh-tui-find/panel-model
 */
import type { ResolvedConfig } from './config.js'
import { t } from './i18n.js'
import type { ScanProgress, ScannedSession, SessionScanner } from './core/scan.js'
import { regexRejection, searchSessions, type RegexRejection, type SearchScope, type SessionHit } from './core/search.js'
import { buildRows, buildSearchOptions, rowSession, sinceMsFor } from './find-rows.js'
import { appendQueryText, dropQueryTail, type FlatRow } from './find-types.js'
import type { SceneSeed } from './scene.js'
import { buildScanOptions, SessionFlush } from './find-sweep.js'
import type { SweepClaim, SweepGate } from './sweep-gate.js'

/** A transient one-line notice the panel shows above its hint (scan failure,
 *  a refused scene open). Same shape as the scene's StatusNote. */
export interface PanelNotice {
  readonly text: string
  readonly tone: 'info' | 'error'
}

/** What the view renders from. Referentially stable snapshots only —
 *  `useSyncExternalStore` re-renders on identity, not equality. */
export interface PanelSnapshot {
  readonly phase: 'cold' | 'indexing' | 'ready' | 'failed'
  readonly query: string
  /** Live sweep progress; undefined once the sweep has landed. */
  readonly progress: ScanProgress | undefined
  /** The count a landed sweep left behind (R-115's settled-sub-agent rule). */
  readonly hiddenSubagents: number
  /** Sessions that hold hits, in the sweep's recency order. */
  readonly hits: readonly SessionHit[]
  readonly rows: readonly FlatRow[]
  readonly selected: number
  readonly expanded: ReadonlySet<string>
  /** Why an otherwise empty list is empty, when it is the pattern's fault. */
  readonly regexRejected: RegexRejection | undefined
  readonly notice: PanelNotice | undefined
}

const EMPTY_SNAPSHOT: PanelSnapshot = {
  phase: 'cold',
  query: '',
  progress: undefined,
  hiddenSubagents: 0,
  hits: [],
  rows: [],
  selected: 0,
  expanded: new Set<string>(),
  regexRejected: undefined,
  notice: undefined,
}

/** Field-by-field identity guard: a write that changes nothing visible must
 *  not re-render the panel (progress ticks land per log file). */
function sameSnapshot(a: PanelSnapshot, b: PanelSnapshot): boolean {
  return (
    a.phase === b.phase &&
    a.query === b.query &&
    a.progress === b.progress &&
    a.hiddenSubagents === b.hiddenSubagents &&
    a.hits === b.hits &&
    a.rows === b.rows &&
    a.selected === b.selected &&
    a.expanded === b.expanded &&
    a.regexRejected === b.regexRejected &&
    a.notice === b.notice
  )
}

/** The panel's external store. Arrow-bound methods so the instance itself
 *  serves as the `useSyncExternalStore` pair (WarmupStore precedent). */
export class FindPanelStore {
  private readonly listeners = new Set<() => void>()
  private snapshot: PanelSnapshot = EMPTY_SNAPSHOT

  getSnapshot = (): PanelSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  set(next: PanelSnapshot): void {
    if (sameSnapshot(this.snapshot, next)) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}

export interface PanelDriverOptions {
  /** The plugin-scoped scanner (main.tsx) — the same instance the warm-up and
   *  the scene sweep with, which is what makes the panel's own sweep pay
   *  per-file stats instead of a cold decode. */
  readonly scanner: SessionScanner
  /** Config, re-read on every derivation: the settings service edits live
   *  values and the panel honors them on the next keystroke. */
  readonly config: () => ResolvedConfig
  /** Scene-open probe: a full-screen scene supersedes this sweep (it runs its
   *  own on mount) and the panel is unmounted while one is up. */
  readonly isSceneOpen: () => boolean
  /** Open the full-screen scene seeded with the panel's query and the row the
   *  user picked. Supplied by main.tsx (it owns the scene runtime and the
   *  one-shot seed). */
  readonly openScene: (seed: SceneSeed) => boolean
  /** The single-sweep slot. Absent = unarbitrated (tests, and any composition
   *  where the panel is the only sweeper). */
  readonly gate?: SweepGate
}

/**
 * The panel's controller. One instance per plugin activation, created in
 * main.tsx beside the scanner; the component never constructs state of its own.
 */
export class FindPanelDriver {
  readonly store = new FindPanelStore()

  private phase: PanelSnapshot['phase'] = 'cold'
  private query = ''
  private sessions: readonly ScannedSession[] = []
  private hits: readonly SessionHit[] = []
  private rows: readonly FlatRow[] = []
  private expanded: ReadonlySet<string> = new Set<string>()
  private progress: ScanProgress | undefined
  private hiddenSubagents = 0
  private regexRejected: RegexRejection | undefined
  private notice: PanelNotice | undefined
  /** The repo scope's cwd, pushed by the view from the host's read-only
   *  session snapshot (the channel cwd the scene reads). */
  private repoCwd: string | undefined
  private selected = 0
  private controller: AbortController | undefined
  private claim: SweepClaim | undefined
  /** Whether the panel component is on screen (the host mounts plugin panels
   *  only while they are the active tab). Drives the background badge. */
  private mounted = false
  /** Set once the host registration resolved its own (host-assigned) panel id
   *  — see {@link bindBadge}. */
  private setBadge: ((badge: { readonly level: 'info' | 'warning' | 'error'; readonly unread: number } | null) => void) | undefined

  constructor(private readonly options: PanelDriverOptions) {}

  getSnapshot = (): PanelSnapshot => this.store.getSnapshot()

  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** The view mounted and this panel is the active one: make sure the index
   *  is being built. Idempotent — a re-mount (panel switch, sidebar reopen)
   *  does not start a second sweep, a sweep aborted by a scene open is
   *  restarted here, and a FAILED sweep gets one more chance per mount (a
   *  transient read error must not leave the panel dead for the session; the
   *  retry is bounded by the user actually coming back to the tab). */
  attach(): void {
    this.mounted = true
    if (this.phase === 'cold' || this.phase === 'failed') this.beginSweep()
  }

  /** The view unmounted (another tab, sidebar collapsed): the index keeps
   *  building, and a settle from here on lights the panel's badge instead. */
  detach(): void {
    this.mounted = false
  }

  /**
   * Give the driver a way to badge its own panel. The id is HOST-ASSIGNED
   * (`panels.register` auto-prefixes it — with a component identity when the
   * activation has one, otherwise a synthesized `act<N>:<id>`), so the
   * registration resolves it through `list()` and hands the callback down;
   * without that resolution there is nothing to address `badge()` with.
   */
  bindBadge(
    setBadge: (badge: { readonly level: 'info' | 'warning' | 'error'; readonly unread: number } | null) => void,
  ): void {
    this.setBadge = setBadge
  }

  /**
   * A settled sweep that nobody was watching: the panel is not on screen (the
   * user switched tabs, or the sidebar is collapsed), so the only signal left
   * is the tab's badge. The host clears it when the panel becomes active, so
   * this cannot strand an unread dot on the panel the user is looking at.
   */
  private announceSettled(failed: boolean): void {
    if (this.mounted) return
    try {
      this.setBadge?.({ level: failed ? 'error' : 'info', unread: 0 })
    } catch {
      // Fire-and-forget: the host's liveness gate can reject a call made from
      // a scan callback, and the badge is additive feedback only.
    }
  }

  /** The view mounted with the host's cwd (repo scope). A change re-derives
   *  the list: the repo scope matches on it. */
  setRepoCwd(cwd: string | undefined): void {
    if (this.repoCwd === cwd) return
    this.repoCwd = cwd
    this.derive()
  }

  /** Replace the query outright (Esc's clear, the initial seed). */
  setQuery(next: string): void {
    if (this.query === next) return
    this.query = next
    // A query edit re-shapes the list: the selection returns to the top, the
    // scene's own rule. It has to be the DERIVATION that resets it — the
    // anchor below re-resolves the old top row's id and would otherwise put
    // the highlight back where it was (the streaming-flush rule must not
    // apply to a query edit).
    this.notice = undefined
    this.derive({ resetSelection: true })
  }

  /** Typed text: appended through the same primitive the scene's input box
   *  uses (find-types.appendQueryText). */
  appendInput(typed: string): void {
    this.setQuery(appendQueryText(this.query, typed))
  }

  /** Backspace / Delete: one code point off the tail. */
  backspace(): void {
    this.setQuery(dropQueryTail(this.query))
  }

  move(delta: number): void {
    this.select(this.selected + delta)
  }

  /** PgUp/PgDn: one list viewport. */
  page(direction: -1 | 1, height: number): void {
    this.select(this.selected + direction * Math.max(1, height))
  }

  /** Click / hover selection. */
  select(index: number): void {
    const clamped = Math.min(Math.max(0, Math.trunc(index)), Math.max(0, this.rows.length - 1))
    if (clamped === this.selected) return
    this.selected = clamped
    this.publish()
  }

  /** Flip the selected row's session fold (Tab). */
  toggleFold(): void {
    const row = this.rows[this.selected]
    if (row === undefined) return
    const id = rowSession(row).id
    // Recent-mode cards carry no hit bundle, so there is nothing to fold —
    // the same rule the scene's Alt+E / badge path applies.
    const hasHits = row.kind === 'message' || (row.hits?.some(entry => entry.kind === 'message') ?? false)
    if (!hasHits) return
    const next = new Set(this.expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    this.expanded = next
    this.derive()
  }

  /**
   * Open the full-screen scene on the selected row, handing over the query so
   * the scene continues this search instead of starting over.
   *
   * The ORDER matters: the host is asked first, and only a scene that really
   * opened supersedes this sweep (the scene runs its own on mount — two at
   * once is exactly what the gate exists to prevent). A REFUSED open must not
   * leave the panel with a dead index: nothing is on screen to replace this
   * list, so the sweep is restarted instead.
   */
  openSelected(): boolean {
    const row = this.rows[this.selected]
    if (row === undefined) return false
    const opened = this.options.openScene({ query: this.query, rowId: row.rowId })
    if (!opened) {
      // A host without a live scenes runtime, or a scene registration that
      // never landed. Keep the list alive; the notice explains the key.
      if (this.phase === 'cold') this.beginSweep()
      this.notice = { text: t('panel-open-failed'), tone: 'error' }
      this.publish()
      return false
    }
    this.yieldToScene()
    return true
  }

  /**
   * Stand down because the full-screen scene is taking over: abort this
   * sweep and drop to `cold` so the next attach (the panel coming back after
   * the scene closes) re-sweeps against the cache this one warmed.
   *
   * Called both when this panel opens the scene itself and by main.tsx's
   * shared `openSceneWith` — the `/find` command and the global shortcut reach
   * the scene through the same entry, and without this call the panel's sweep
   * would keep decoding behind a scene it cannot see (the probe the driver
   * also carries runs in async scan callbacks, where the caller-bound
   * `tuiScenes` getter can degrade to "no scene").
   */
  yieldToScene(): void {
    this.abortSweep()
  }

  /** Plugin dispose: nothing outlives the activation. */
  dispose(): void {
    this.abortSweep()
  }

  // ── the sweep ─────────────────────────────────────────────────────────

  private beginSweep(): void {
    if (this.phase === 'indexing') return
    const claim = this.options.gate?.claim('panel')
    if (this.options.gate !== undefined && claim === undefined) return
    this.claim = claim
    const controller = new AbortController()
    this.controller = controller
    this.phase = 'indexing'
    this.notice = undefined
    this.publish()
    const config = this.options.config()
    const flush = new SessionFlush()
    void this.options.scanner
      .scan(
        buildScanOptions(config, {
          signal: controller.signal,
          onProgress: progress => {
            // An aborted file can still deliver one trailing tick; never
            // resurrect a settled panel (the warm-up's rule).
            if (this.superseded(controller)) return
            this.progress = progress
            this.hiddenSubagents = progress.hiddenSubagents
            this.publish()
          },
          onSession: session => {
            if (this.superseded(controller)) return
            const flushed = flush.push(session)
            if (flushed === undefined) return
            this.sessions = flushed
            this.derive()
          },
        }),
      )
      .then(result => {
        if (this.superseded(controller)) return
        this.sessions = result
        this.phase = 'ready'
        this.progress = undefined
        this.derive()
        this.settle()
        this.announceSettled(false)
      })
      .catch((error: unknown) => {
        // A stale sweep's rejection is not this panel's failure: an aborted
        // sweep normally RESOLVES with its partial results, so a rejection is
        // a real error — but it may arrive after the scene superseded this
        // sweep and the panel started a NEWER one. Settling then would clobber
        // the live sweep's phase and release a claim that is no longer ours
        // (letting a third sweeper start on top of it), so only the current
        // controller may settle.
        if (this.controller !== controller) return
        this.controller = undefined
        this.claim?.release()
        this.claim = undefined
        this.phase = 'failed'
        this.progress = undefined
        this.notice = {
          text: t('scan-failed', { error: error instanceof Error ? error.message : String(error) }),
          tone: 'error',
        }
        this.derive()
        this.announceSettled(true)
      })
  }

  /** Whether this sweep is already moot: aborted, preempted by another
   *  sweeper, or superseded by an open scene. */
  private superseded(controller: AbortController): boolean {
    if (controller.signal.aborted) return true
    if (this.claim?.lost() === true) {
      this.releaseAfterAbort(controller)
      return true
    }
    if (!this.options.isSceneOpen()) return false
    this.releaseAfterAbort(controller)
    return true
  }

  /** A sweep stopped by someone else: drop to `cold` so the next attach (the
   *  panel coming back after the scene closes) re-sweeps — against a cache
   *  this sweep already warmed, so the restart is cheap. The rows already in
   *  the store stay on screen meanwhile. */
  private releaseAfterAbort(controller: AbortController): void {
    controller.abort()
    if (this.controller === controller) this.controller = undefined
    this.claim?.release()
    this.claim = undefined
    this.progress = undefined
    if (this.phase === 'indexing') this.phase = 'cold'
    this.publish()
  }

  private settle(): void {
    this.controller = undefined
    this.claim?.release()
    this.claim = undefined
  }

  private abortSweep(): void {
    const controller = this.controller
    if (controller !== undefined) {
      controller.abort()
      this.controller = undefined
    }
    this.claim?.release()
    this.claim = undefined
    this.progress = undefined
    if (this.phase === 'indexing') this.phase = 'cold'
    this.publish()
  }

  // ── the search derivation ─────────────────────────────────────────────

  /** Re-run the search over the sessions accumulated so far and rebuild the
   *  rows. Called on every query edit, every flush and every index settle —
   *  the same incremental-search shape the scene's memos have.
   *
   * `resetSelection` is for the callers whose change RE-SHAPES the list from
   * the top (a query edit): every other caller keeps the selected row across
   * the rebuild, because a streaming flush can insert a more recent session
   * ABOVE the rows already on screen. */
  private derive(options: { readonly resetSelection?: boolean } = {}): void {
    const config = this.options.config()
    const recentMode = this.query.trim().length === 0
    const scope: SearchScope = config.defaultScope
    const sinceMs = sinceMsFor(config.defaultTime)
    this.regexRejected =
      config.regex && !recentMode ? regexRejection(this.query.trim(), config.caseSensitive) : undefined
    const hits = recentMode
      ? []
      : searchSessions(
          this.sessions,
          this.query,
          buildSearchOptions(config, {
            scope,
            repoCwd: this.repoCwd,
            useRegex: config.regex,
            titleOnly: config.titleOnly,
            sinceMs,
          }),
        )
    this.hits = hits
    const nextRows = buildRows({
      sessions: this.sessions,
      hits,
      recentMode,
      scope,
      repoCwd: this.repoCwd,
      sinceMs,
      expanded: this.expanded,
    })
    if (options.resetSelection === true) {
      this.selected = 0
    } else {
      // Selection anchoring, the scene's rule: a streaming flush can insert a
      // more recent session ABOVE the rows already on screen, so the index is
      // re-resolved from the selected row's stable id and only falls back to
      // the clamp when that row left the list.
      const anchor = this.rows[this.selected]?.rowId
      const found = anchor === undefined ? -1 : nextRows.findIndex(row => row.rowId === anchor)
      this.selected = found === -1 ? Math.min(this.selected, Math.max(0, nextRows.length - 1)) : found
    }
    this.rows = nextRows
    this.publish()
  }

  private publish(): void {
    this.store.set({
      phase: this.phase,
      query: this.query,
      progress: this.progress,
      hiddenSubagents: this.hiddenSubagents,
      hits: this.hits,
      rows: this.rows,
      selected: this.selected,
      expanded: this.expanded,
      regexRejected: this.regexRejected,
      notice: this.notice,
    })
  }
}
