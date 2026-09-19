/**
 * The background warm-up index (batch 4): after a fixed quiet delay past
 * activation, run ONE scanner sweep on the plugin-scoped scanner so the
 * first /find open pays per-file stats instead of the cold decode. The
 * watermark journal is a record, not a data source — a cold process must
 * re-decode every prefix anyway (scan.ts), so the warm-up does not lower
 * total CPU, it re-distributes it away from the user's first search; the
 * design trade-offs live in docs/decisions/2026-09-12-background-warmup-index.md.
 *
 * Progress rides the 0.10+ `tuiStatus.registerView` seam (a rich status view
 * above the prompt, maxRows 1, pointer-only kit). The 0.9.3 build baseline's
 * `TuiStatusRuntime` carries only `set(key, text)`, so the surface is reached
 * structurally — soft probe plus an `unknown` narrowing (notify.ts precedent).
 * A 0.9.x host (or any composition without the view seam) still warms up,
 * silently: `tuiStatus.set` is deliberately NOT a fallback carrier (every
 * progress tick would bind another dead caller effect, and the caller
 * resolution of a deferred-timer `set` call is host-internal semantics the
 * plugin must not couple to).
 *
 * Discipline: no host seam call ever originates from the deferred timer or
 * the view. The timer path only runs `scanner.scan` and updates the plugin's
 * own external store (plain JS); the view's click handler only aborts the
 * driver's own controller. `registerView` itself runs in one of the two
 * plugin-owned flows every other seam uses — synchronously during apply
 * (`tuiScenes` already mounted) or on the `whenSeamMounted` poll tick, a
 * plain timer created during apply (see seam.ts) — so the caller-fiber
 * liveness gate sees this activation's own token (or an empty store, which
 * it skips), never a foreign activation's.
 *
 * @module dsh-tui-find/warmup
 */
import type React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.js'
import { t } from './i18n.js'
import type { SessionScanner } from './core/scan.js'
import { prewarmFolds, PREWARM_MAX_MESSAGES, PREWARM_MAX_MS } from './core/search.js'
import { registerSeamWithRetry } from './seam.js'

/** Quiet delay between apply and the warm-up sweep: long enough that the
 *  TUI boot has fully settled (the sweep must never compete with it), short
 *  enough to beat a user's first /find. Internal constant — the config face
 *  is a plain on/off (`warmup`). */
export const WARMUP_DELAY_MS = 10_000

/** The view's status key, plugin-namespaced per the host's colon convention
 *  (validated against the host's KEY_PATTERN — lowercase slug segments). */
export const WARMUP_VIEW_KEY = 'dsh-tui-find:warmup'

/** What the view renders from. Referentially stable snapshots only —
 *  `useSyncExternalStore` re-renders on identity, not equality. */
export interface WarmupSnapshot {
  readonly phase: 'idle' | 'running'
  readonly resolved: number
  readonly total: number | undefined
}

/**
 * The warm-up progress store: cordis-free, plugin-owned (the seam doc pins
 * live data to "an external store" owned by the component). Arrow-bound
 * methods so the instance itself can serve as the subscription pair.
 */
export class WarmupStore {
  private readonly listeners = new Set<() => void>()
  private snapshot: WarmupSnapshot = { phase: 'idle', resolved: 0, total: undefined }

  getSnapshot = (): WarmupSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A new object crosses only when something visible changed, so idle
   *  re-settles and same-count progress ticks never re-render the prompt. */
  update(phase: WarmupSnapshot['phase'], resolved: number, total: number | undefined): void {
    const current = this.snapshot
    if (current.phase === phase && current.resolved === resolved && current.total === total) return
    this.snapshot = { phase, resolved, total }
    for (const listener of [...this.listeners]) listener()
  }
}

// ── the 0.10+ view surface, structural (see module doc) ────────────────

/** Pointer-only Box props the warm-up row uses: click-to-cancel is the only
 *  interactive affordance `registerView`'s kit keeps (keyboard, wheel,
 *  context menu, focus and ref props are host-forbidden there). */
interface WarmupViewBoxProps {
  children?: React.ReactNode
  onClick?: (event: { stopImmediatePropagation(): void }) => void
}

interface WarmupViewTextProps {
  children?: React.ReactNode
  dimColor?: boolean
}

export interface WarmupViewUi {
  readonly Box: React.ComponentType<WarmupViewBoxProps>
  readonly Text: React.ComponentType<WarmupViewTextProps>
}

export interface WarmupViewProps {
  readonly React: typeof React
  readonly ui: WarmupViewUi
}

export type WarmupViewComponent = React.ComponentType<WarmupViewProps>

export interface WarmupStatusViewDescriptor {
  readonly key: string
  readonly maxRows?: 1 | 2 | 3
  readonly component: WarmupViewComponent
}

/** The probed slice of the 0.10+ `TuiStatusRuntime`. Optional method: the
 *  probe's whole point is that the 0.9.3 surface (and any future drift)
 *  may not carry it. */
interface WarmupStatusSurface {
  registerView?(descriptor: WarmupStatusViewDescriptor): (() => void) | undefined
}

/**
 * Build the view component for one registration attempt. Fresh closure per
 * attempt (the same discipline as the command-tree provider): the host
 * stores the component instance it receives, and a retried registration
 * must not share closure state with one the host may have kept from a
 * rejected attempt.
 */
export function buildWarmupView(store: WarmupStore, onCancel: () => void): WarmupViewComponent {
  const WarmupView = (props: WarmupViewProps): React.ReactElement | null => {
    const { React, ui } = props
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    // Idle (and the settled-after-sweep state) renders nothing: the view is
    // registered for the whole activation, but the prompt area stays clean
    // unless a sweep is actually running.
    if (snapshot.phase !== 'running') return null
    // Contract tolerance, not a live path: scan.ts sets `total` at the top of
    // its per-file loop, so every between-file onProgress tick carries one —
    // running-without-total is unreachable in production today (only tests
    // poke the store into this state). Kept because the ScanProgress contract
    // still allows undefined before enumeration finishes: a future
    // enumeration-phase yield must render a sane "indexing…" row, not
    // "Indexing 3/undefined".
    const text =
      snapshot.total === undefined
        ? t('warmup-initial')
        : t('warmup-progress', { resolved: snapshot.resolved, total: snapshot.total })
    return (
      <ui.Box onClick={() => onCancel()}>
        <ui.Text dimColor>{`⌕ dsh-tui-find · ${text}`}</ui.Text>
      </ui.Box>
    )
  }
  return WarmupView
}

// ── the driver ──────────────────────────────────────────────────────────

export interface WarmupDriverOptions {
  /** The plugin-scoped scanner (main.tsx): the warm-up fills the SAME cache
   *  the scene's sweep reads — that identity is what makes the first open
   *  cheap. */
  readonly scanner: SessionScanner
  /** Config, resolved at sweep START: settings edits made between apply and
   *  the delayed start apply naturally; a mid-sweep change leaves the
   *  running sweep on its captured options (the scene's next sweep
   *  re-decodes correctly through the scanner's own optionsKey discipline). */
  readonly config: () => ResolvedConfig
  /** Scene-open probe — a positive check supersedes the warm-up (the scene's
   *  own sweep takes over; the background copy would only duplicate decode
   *  work). */
  readonly isSceneOpen: () => boolean
}

/**
 * One delayed warm-up sweep per activation. Cancellation is three-layer:
 * the scene opening supersedes (checked at start and every per-file progress
 * tick), the user cancels through the view's click handler, and plugin
 * dispose aborts everything. Any settle path (complete / abort / fail)
 * returns the store to idle so the view vanishes.
 */
export class WarmupDriver {
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined
  private started = false

  constructor(
    private readonly ctx: Context,
    private readonly options: WarmupDriverOptions,
    private readonly store: WarmupStore,
  ) {}

  /** Schedule the delayed start; a no-op after the first call. */
  arm(): void {
    if (this.timer !== undefined || this.started) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.begin()
    }, WARMUP_DELAY_MS)
  }

  /** User-facing cancel (the view's click): settle immediately so the view
   *  reacts this frame, not after the scan notices the abort. */
  cancel(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const controller = this.controller
    if (controller === undefined) return
    controller.abort()
    this.settle(controller)
  }

  /** Plugin dispose: no timer or sweep outlives the activation. */
  dispose(): void {
    this.cancel()
  }

  /** Start-time gates: the config toggle is re-read here (a mid-session
   *  settings edit applies to the not-yet-started sweep), and an already
   *  open scene means the warm-up's purpose is moot.
   *
   *  The sweep has two halves now: `scanner.scan` pays the per-file decode,
   *  then {@link prewarmFolds} builds the fold caches the first keystroke
   *  would otherwise buy. The second half is what lets a letter query be
   *  served without a cold build on its first key press; both halves share
   *  the one controller, so the view's cancel and an opening scene stop the
   *  prewarm at its next yield.
   */
  private begin(): void {
    this.started = true
    if (!this.options.config().warmup) return
    if (this.options.isSceneOpen()) return
    const controller = new AbortController()
    this.controller = controller
    const config = this.options.config()
    void this.options.scanner
      .scan({
        indexTools: config.indexTools,
        indexThinking: config.indexThinking,
        maxMessageChars: config.maxMessageChars,
        ...(config.sessionRoot === undefined ? {} : { sessionRoot: config.sessionRoot }),
        signal: controller.signal,
        onProgress: progress => {
          // An aborted file can still deliver one trailing progress tick
          // (scan.ts fires onProgress for the file it was aborted inside);
          // never resurrect the view after a cancel.
          if (this.superseded(controller)) return
          this.store.update('running', progress.resolved, progress.total)
        },
      })
      .then(sessions => {
        // The scan already answered for an aborted or superseded run; the
        // prewarm must not start one that nobody is waiting for.
        if (this.superseded(controller)) return
        // A partial warm is the normal outcome of the budget: the view
        // reports what was warmed, and the search simply builds the rest on
        // demand (see prewarmFolds).
        return prewarmFolds(sessions, {
          pinyin: config.pinyin,
          // The shapes the scene will probe: a sensitive session rebuilds
          // every chain the insensitive warm filled (see prewarmFolds).
          caseSensitive: config.caseSensitive,
          maxMessages: PREWARM_MAX_MESSAGES,
          maxMs: PREWARM_MAX_MS,
          signal: controller.signal,
          onProgress: progress => {
            if (this.superseded(controller)) return
            this.store.update('running', progress.warmed, progress.total)
          },
        })
      })
      .then(() => {
        this.settle(controller)
      })
      .catch((error: unknown) => {
        this.settle(controller)
        // The warm-up is a optimization, never a dependency: a failed sweep
        // degrades to the pre-batch-4 behavior (/find scans on open).
        this.ctx.logger.warn(
          `dsh-tui-find: warm-up sweep failed (${error instanceof Error ? error.message : String(error)}); /find still scans on open`,
        )
      })
  }

  /** Whether this sweep's work is already moot: the user cancelled it, or
   *  /find opened and its own sweep supersedes this one. Settles the driver
   *  on the scene-open path (the scan's own onProgress tick does, but the
   *  prewarm's does not fire until its first yield). */
  private superseded(controller: AbortController): boolean {
    if (controller.signal.aborted) return true
    if (!this.options.isSceneOpen()) return false
    controller.abort()
    this.settle(controller)
    return true
  }

  private settle(controller: AbortController): void {
    if (this.controller === controller) this.controller = undefined
    this.store.update('idle', 0, undefined)
  }
}

export interface WarmupOptions {
  readonly scanner: SessionScanner
  readonly config: () => ResolvedConfig
  readonly isSceneOpen: () => boolean
}

/**
 * Wire the warm-up for one activation: register the progress view when the
 * host carries the 0.10+ rich status seam, then arm the delayed sweep. Both
 * halves scope to `ctx.effect`; the config `warmup` row (re-read at start
 * time) disables the sweep on every host, while the view stays registered
 * but renders nothing.
 *
 * @param ctx - the plugin activation context.
 * @param options - driver inputs; see {@link WarmupDriverOptions}.
 */
export function setupWarmup(ctx: Context, options: WarmupOptions): void {
  const store = new WarmupStore()
  const driver = new WarmupDriver(ctx, options, store)

  const status = ctx.get('tuiStatus', false) as unknown as WarmupStatusSurface | undefined
  if (status !== undefined && typeof status.registerView === 'function') {
    const register = (): (() => void) => {
      const dispose = status.registerView!({
        key: WARMUP_VIEW_KEY,
        maxRows: 1,
        component: buildWarmupView(store, () => driver.cancel()),
      })
      // The host REFUSES without throwing (liveness window, duplicate key,
      // exhausted view-row budget) and warns internally; surface that as the
      // retry machinery's failure shape. A permanent refusal burns the
      // bounded budget with one warning — the warm-up itself is unaffected
      // (the view is additive chrome, its absence is the 0.9.x behavior).
      if (dispose === undefined) {
        throw new Error('tuiStatus.registerView refused the warm-up view')
      }
      return dispose
    }
    try {
      const dispose = register()
      ctx.effect(() => dispose)
    } catch (error) {
      registerSeamWithRetry(ctx, 'warm-up status view', register, dispose => ctx.effect(() => dispose), error)
    }
  }

  driver.arm()
  ctx.effect(() => () => driver.dispose())
}
