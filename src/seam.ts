/**
 * Retry helper for guarded host-seam registrations.
 *
 * Every seam the plugin registers through (`tuiScenes`, `tuiShortcuts`,
 * `tuiSettingsSections`) rides the host's liveness gate (`assertLiveContext`
 * in the host's `dsh-adapter/host-access.js`): the caller's fiber must
 * already sit in the runtime's trust table. That table is fed by
 * `internal/plugin` / `internal/status` listeners which the runtime installs
 * when its service is constructed — and on a cold boot that construction can
 * land between this plugin fiber's creation/LOADING events and its `apply`.
 * Inside that window every guarded call rejects with the host's unified
 * "requires a live Cordis activation context" error.
 *
 * The window is transient by construction: cordis emits the fiber's ACTIVE
 * status event right after `apply` returns, the runtime's status listener
 * records the fiber at the latest there, and a macrotask timer observes it
 * deterministically afterwards. A rejected registration is also rolled back
 * atomically by the host (`bindCallerEffect` disposes the contribution on
 * failure), so retrying never stacks half-applied state.
 *
 * This must stay a contained, bounded retry — never a thrown error. Letting
 * the race fail the activation takes the whole TUI boot down with it (the
 * host's plugin loader is fail-closed on entry failures), which is exactly
 * what shipped as the 0.1.5 startup breakage.
 *
 * Both helpers poll on a two-phase budget (R-107): a fast window (25 ms
 * ticks) for the boot race they were built for, then a slow cadence until
 * {@link SEAM_TOTAL_BUDGET_MS}. The original budgets (0.5 s to retry, 5 s to
 * mount) were guesses at the boot window, and both ended in a TERMINAL state
 * that only the log recorded — a user saw "the TUI started fine, but /find
 * never opens again until the plugin is reloaded". The activation's own
 * lifetime bounds the poll regardless (`ctx.effect` clears the timer when the
 * fiber leaves ACTIVE), so the total budget is the "this host really has no
 * TUI" cutoff, not a boot-window estimate — and the give-up now also rides
 * the host's toast seam, which is the one channel a TUI user can see.
 *
 * @module dsh-tui-find/seam
 */
import type { Context } from '@deepseek-ai/cordis'
import { t } from './i18n.js'
import { makeNotifier } from './notify.js'

/** Fast-phase retry budget: the window is microtask-wide, so a handful of
 *  macrotasks is orders of magnitude more than enough; the rest is slack for
 *  a busy boot. 200 × 25 ms = 5 s. */
export const REGISTER_RETRY_MAX_ATTEMPTS = 200

/** Fast-phase retry cadence; the fast window is delay × max attempts (5 s). */
export const REGISTER_RETRY_DELAY_MS = 25

/** Late-mount fast phase for a seam service that was not yet mounted at
 *  apply: 200 × 25 ms = 5 s, orders of magnitude over the observed ~100 ms
 *  the TUI runtimes need after a plugin's cold-boot apply. */
export const SEAM_MOUNT_MAX_ATTEMPTS = 200
export const SEAM_MOUNT_DELAY_MS = 25

/** Slow-phase cadence past the fast window: an order of magnitude fewer
 *  probes per second, so a host that mounts its TUI minutes late still gets
 *  the feature instead of a dead entry. */
export const SEAM_SLOW_DELAY_MS = 5000

/** Total polling budget: 5 s fast + 5 s × 119 slow ≈ 10 minutes. A seam that
 *  has not appeared by then is not late, it is absent. */
export const SEAM_TOTAL_BUDGET_MS = 10 * 60 * 1000

/**
 * Poll `tick` on the two-phase budget, and run `onGiveUp` once at the
 * deadline. `tick` runs first at every step, including the giving-up one, so
 * a seam that arrives exactly on the last tick still lands; it returns true
 * when the loop's work is done and polling should stop.
 *
 * @returns the poll's disposer (the activation's unload must not leave a tick
 *   behind).
 */
function pollOnBudget(
  fastAttempts: number,
  fastDelayMs: number,
  tick: () => boolean,
  onGiveUp: () => void,
): () => void {
  let elapsed = 0
  let ticks = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (): void => {
    const delay = ticks < fastAttempts ? fastDelayMs : SEAM_SLOW_DELAY_MS
    timer = setTimeout(() => {
      timer = undefined
      elapsed += delay
      ticks += 1
      if (tick()) return
      if (elapsed >= SEAM_TOTAL_BUDGET_MS) {
        // Terminal for this poll, and a throw from a timer callback would be
        // an uncaughtException; the feature is already unavailable either way.
        try {
          onGiveUp()
        } catch {
          // Nothing left to report on.
        }
        return
      }
      schedule()
    }, delay)
  }
  schedule()
  return () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
}

/**
 * Tell the user a seam gave up, on the one channel they can see. The logger
 * line alone is invisible inside a full-screen TUI, and a gave-up
 * registration is terminal for the activation — the feature stays missing
 * until the plugin reloads (R-107). Deliberately label-free: the copy names
 * no feature (the log line carries the label), so it stays true for the
 * scene, a shortcut and the warm-up view alike. A composition without a
 * toast surface (0.9.x, headless) simply gets the log line, as before.
 */
function announceGiveUp(ctx: Context): void {
  try {
    makeNotifier(ctx)(t('toast-seam-unavailable'), 'error')
  } catch {
    // Additive channel: the warn/info above already carries the signal.
  }
}

/**
 * Run `use` on a seam service as soon as it exists. The bare soft-probe
 * (`ctx.get(seam, false)`) silently skips the registration when this plugin's
 * apply wins the race against the TUI runtime's own startup — every /find
 * then fails to open for the whole session (observed on a real 0.10.1 boot
 * with engine rc.2). Poll instead.
 *
 * Deliberately NOT `ctx.inject`: cordis binds a service proxy's caller to the
 * context the `.get()` ran on, and inside an inject callback the host's
 * liveness token belongs to the injected service's fiber — a registration
 * made there is owned by a foreign activation, and every later `open()` from
 * this plugin is rejected ("belongs to another activation"). A plain timer
 * created during apply carries this activation's own token (or an empty
 * store, which the gate skips), so the registration stays owned by us.
 *
 * `probe` must resolve the seam through the plugin's own context; it runs
 * synchronously first and then on each tick. Give-up is an info, not a warn:
 * on a composition that genuinely has no TUI runtimes this is the designed
 * no-op posture, not a degradation (it still rides the toast seam, which only
 * a TUI host carries — see {@link announceGiveUp}). A throwing `use` is
 * contained to a single warning — on the poll tick an escape would be an
 * uncaughtException (the old `ctx.inject` ran its callback inside a managed
 * fiber with host-level disposal), and on the synchronous path it would fail
 * the whole activation; present call sites are all guarded, so this is
 * containment for future ones.
 */
export function whenSeamMounted<T>(
  ctx: Context,
  label: string,
  probe: () => T | undefined,
  use: (seam: T) => void,
): void {
  const run = (seam: T): void => {
    try {
      use(seam)
    } catch (error) {
      ctx.logger.warn(
        `dsh-tui-find: ${label} setup failed (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }
  const first = probe()
  if (first !== undefined) {
    run(first)
    return
  }
  const stop = pollOnBudget(
    SEAM_MOUNT_MAX_ATTEMPTS,
    SEAM_MOUNT_DELAY_MS,
    () => {
      let seam: T | undefined
      try {
        seam = probe()
      } catch {
        seam = undefined
      }
      if (seam === undefined) return false
      run(seam)
      return true
    },
    () => {
      ctx.logger.info(
        `dsh-tui-find: ${label} never mounted within the ${Math.round(SEAM_TOTAL_BUDGET_MS / 1000)} s budget; the feature stays unavailable this session`,
      )
      announceGiveUp(ctx)
    },
  )
  // A deactivated/restarted activation must not leave poll timers behind.
  ctx.effect(() => stop)
}

/** A guarded host-seam registration: returns the contribution's disposer. */
export type SeamRegistration = () => () => void

/**
 * Retry a seam registration that just failed, tolerating the boot liveness
 * window. `register` is attempted on a macrotask timer until it succeeds or
 * the budget runs out; `attach` scopes the returned disposer to this
 * activation (kept out of `register` so the timer path can attach it on the
 * now-ACTIVE fiber). Both the recovery and the give-up are logged warnings —
 * a silent retry would hide a real degradation behind a working-looking boot —
 * and the give-up also reaches the user's toast surface (R-107): it is a
 * terminal state for the activation, so a log-only report reads as "/find
 * silently stopped working" until the plugin is reloaded.
 *
 * @param ctx - the plugin activation context (logger + effect scope).
 * @param label - seam name for log lines (e.g. `'scene'`).
 * @param register - the guarded registration call to retry.
 * @param attach - receives the disposer once a retry succeeds.
 * @param firstError - the error the caller's synchronous attempt threw.
 */
export function registerSeamWithRetry(
  ctx: Context,
  label: string,
  register: SeamRegistration,
  attach: (dispose: () => void) => void,
  firstError: unknown,
): void {
  let attempts = 0
  let lastMessage = firstError instanceof Error ? firstError.message : String(firstError)
  const stop = pollOnBudget(
    REGISTER_RETRY_MAX_ATTEMPTS,
    REGISTER_RETRY_DELAY_MS,
    () => {
      attempts += 1
      try {
        attach(register())
        ctx.logger.warn(
          `dsh-tui-find: ${label} registered on retry #${attempts} (boot liveness race: ${lastMessage})`,
        )
        return true
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : String(error)
        return false
      }
    },
    () => {
      ctx.logger.warn(
        `dsh-tui-find: ${label} registration failed after ${attempts} attempts over ${Math.round(SEAM_TOTAL_BUDGET_MS / 1000)} s (${lastMessage}); the feature stays unavailable until the plugin reloads`,
      )
      announceGiveUp(ctx)
    },
  )
  // A deactivated/restarted activation must not leave retry timers behind.
  ctx.effect(() => stop)
}
