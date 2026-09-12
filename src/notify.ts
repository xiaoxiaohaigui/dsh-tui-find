/**
 * The host's transient-notification seam (`tuiToast`, 0.10+), reached
 * structurally: the 0.9.3 build baseline's cordis Context carries no
 * `tuiToast` declaration, and augmenting the interface would collide with
 * 0.10's own required declaration under the dual-host matrix, so the probe
 * goes through cordis's string-keyed `get` overload and narrows the result.
 *
 * The toast is ADDITIVE feedback on the host's shared notification surface —
 * every caller keeps its existing channel (the scene's status footer, the
 * logger), so a 0.9.x host (no service) or a dropped delivery (no sink yet
 * during the cold-boot window, the host's documented fire-and-forget
 * contract) changes nothing.
 *
 * @module dsh-tui-find/notify
 */
import type { Context } from '@deepseek-ai/cordis'

/** The toast surface this plugin uses, structural per the dual-version strategy. */
export interface ToastSurface {
  show(
    text: string | number | boolean,
    options?: { color?: 'success' | 'warning' | 'error'; timeoutMs?: number },
  ): boolean
}

/** The scene-level feedback callback: fire-and-forget, tone-picked colour. */
export type Notifier = (text: string, tone: 'info' | 'error') => void

/** Auto-dismiss windows; the host clamps into [500, 12000]ms. */
const TOAST_INFO_MS = 2500
const TOAST_ERROR_MS = 4000

/** Build the notifier against one activation's context. The service is
 *  re-resolved at every call (the seam may mount after apply, mirroring the
 *  shortcut registry's cold-boot liveness window). */
export function makeNotifier(ctx: Context): Notifier {
  return (text, tone) => {
    const toast = ctx.get('tuiToast', false) as ToastSurface | undefined
    if (toast === undefined) return
    toast.show(text, {
      ...(tone === 'error' ? { color: 'error' as const } : { color: 'success' as const }),
      timeoutMs: tone === 'error' ? TOAST_ERROR_MS : TOAST_INFO_MS,
    })
  }
}
