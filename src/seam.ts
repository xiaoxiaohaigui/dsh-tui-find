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
 * @module dsh-tui-find/seam
 */
import type { Context } from '@deepseek-ai/cordis'

/** Retry budget: the window is microtask-wide, so a handful of macrotasks is
 *  orders of magnitude more than enough; the rest is slack for a busy boot. */
export const REGISTER_RETRY_MAX_ATTEMPTS = 20

/** Retry cadence; the total budget is delay × max attempts (500 ms). */
export const REGISTER_RETRY_DELAY_MS = 25

/** A guarded host-seam registration: returns the contribution's disposer. */
export type SeamRegistration = () => () => void

/**
 * Retry a seam registration that just failed, tolerating the boot liveness
 * window. `register` is attempted on a macrotask timer until it succeeds or
 * the budget runs out; `attach` scopes the returned disposer to this
 * activation (kept out of `register` so the timer path can attach it on the
 * now-ACTIVE fiber). Both the recovery and the give-up are logged warnings —
 * a silent retry would hide a real degradation behind a working-looking boot.
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
  const timer = setInterval(() => {
    attempts += 1
    try {
      attach(register())
      clearInterval(timer)
      ctx.logger.warn(
        `dsh-tui-find: ${label} registered on retry #${attempts} (boot liveness race: ${lastMessage})`,
      )
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error)
      if (attempts >= REGISTER_RETRY_MAX_ATTEMPTS) {
        clearInterval(timer)
        ctx.logger.warn(
          `dsh-tui-find: ${label} registration failed after ${attempts} attempts (${lastMessage}); the feature stays unavailable until the plugin reloads`,
        )
      }
    }
  }, REGISTER_RETRY_DELAY_MS)
  // A deactivated/restarted activation must not leave retry timers behind.
  ctx.effect(() => () => clearInterval(timer))
}
