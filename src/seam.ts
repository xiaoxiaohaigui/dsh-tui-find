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

/** Late-mount poll budget for a seam service that was not yet mounted at
 *  apply: 200 × 25 ms = 5 s, orders of magnitude over the observed ~100 ms
 *  the TUI runtimes need after a plugin's cold-boot apply. */
export const SEAM_MOUNT_MAX_ATTEMPTS = 200
export const SEAM_MOUNT_DELAY_MS = 25

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
 * no-op posture, not a degradation. A throwing `use` is contained to a
 * single warning — on the poll tick an escape would be an uncaughtException
 * (the old `ctx.inject` ran its callback inside a managed fiber with
 * host-level disposal), and on the synchronous path it would fail the whole
 * activation; present call sites are all guarded, so this is containment
 * for future ones.
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
  let attempts = 0
  const timer = setInterval(() => {
    attempts += 1
    let seam: T | undefined
    try {
      seam = probe()
    } catch {
      seam = undefined
    }
    if (seam === undefined) {
      if (attempts >= SEAM_MOUNT_MAX_ATTEMPTS) {
        clearInterval(timer)
        ctx.logger.info(
          `dsh-tui-find: ${label} never mounted within the boot window; the feature stays unavailable this session`,
        )
      }
      return
    }
    clearInterval(timer)
    run(seam)
  }, SEAM_MOUNT_DELAY_MS)
  // A deactivated/restarted activation must not leave poll timers behind.
  ctx.effect(() => () => clearInterval(timer))
}

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
