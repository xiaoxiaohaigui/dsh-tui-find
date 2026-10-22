/**
 * Defensive bridge to the host's cursor hooks — one contract for both
 * surfaces that own a text caret.
 *
 * Two host generations expose the same hook differently:
 *
 * - **0.15.0+** exports `useDeclaredCursor` and `useNativeCursor` from the
 *   public ui kit (`src/ui.ts`), which is exactly the `ui` a scene receives.
 *   That is the contract to call: it is stable across releases, and the
 *   vendored path below is only its fallback.
 * - **0.13.0/0.14.x** predate the export. The panel also gets a NARROWED kit
 *   (Box/Text/Divider/…, no hooks) on every host generation, and the scene's
 *   IME anchoring must keep working there, so the bridge falls back to loading
 *   the hook module itself from the host package root. Loading happens ONCE at
 *   module scope, synchronously, so the hooks rule stays intact: a scene
 *   either always calls the hook or never does — a hook that appears
 *   mid-lifetime would change the hook count between renders and kill the
 *   reconciler. Any failure — unexpected package layout, a Node without
 *   require-of-ESM, a renamed hook — degrades permanently to no declaration,
 *   which is the pre-fix status quo: both surfaces stay fully functional.
 *
 * What the declaration does with 0.15.0's `visible`:
 *
 * - `active: true` parks the physical cursor, which is what renders a
 *   composing IME's preedit at the input instead of the screen's bottom row.
 *   It is invisible without `visible`.
 * - `visible: true` opts into the terminal's OWN caret — shape, colour,
 *   blink and any enabled animation/trail stay terminal-owned, and the
 *   painted block becomes redundant (the callers stop inverting their caret
 *   cell when `native` is true).
 * - `useNativeCursor()` says whether this renderer can show it at all
 *   (a real TTY with cursor-declaration support). Renderers that cannot —
 *   old hosts, or static/snapshot output — keep the painted fallback, the
 *   same discipline as the host's own SearchBox and PromptInput.
 *
 * Callers therefore pass their INTENT (`visible: true` means "this box owns
 * the keyboard"), and the bridge narrows it with `useNativeCursor()`.
 *
 * @module dsh-tui-find/vendor/host-cursor
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/** Where the caret sits, in the declaring box's own cell coordinates. */
export interface HostCursorOptions {
  readonly line: number
  readonly column: number
  /** Park the cursor (IME anchoring). Clears the declaration when false. */
  readonly active: boolean
  /** The caller's intent: the caret may show natively while this box owns the keyboard. */
  readonly visible?: boolean
}

/** The host hook's ref callback: attach it to the box that contains the caret. */
export type HostCursorRef = (node: object | null) => void

export type UseDeclaredCursor = (options: HostCursorOptions) => HostCursorRef
export type UseNativeCursor = () => boolean

/** The hooks looked up structurally — the full scene kit has both (0.15.0+);
 *  the panel's narrowed kit has neither, and older scenes do not either. */
export interface HostCursorKit {
  readonly useDeclaredCursor?: UseDeclaredCursor | undefined
  readonly useNativeCursor?: UseNativeCursor | undefined
}

/** What one render gets from the bridge. */
export interface HostCursor {
  /** Attach to the caret's box; undefined when no host generation could supply
   *  the hook (silent degrade — the caller renders its painted fallback). */
  readonly ref: HostCursorRef | undefined
  /** True when the terminal draws the caret: the caller must not paint one. */
  readonly native: boolean
}

function loadVendoredHooks(): HostCursorKit {
  try {
    // The host package's `exports` map carries only import conditions, so
    // the entry must be resolved through ESM's resolver (CJS require.resolve
    // rejects it) — then the hook file itself is loaded through a plain
    // require, which Node reads synchronously even for an ESM file. Node
    // shares the module instance with the host's own import, so the React
    // context the hook reads is the one the host rendered under.
    const entryUrl = import.meta.resolve('@deepseek-harness-tui/dsh-tui')
    const packageRoot = fileURLToPath(entryUrl).replace(/[\\/]lib[\\/]types[\\/].*$/, '')
    const hookPath = `${packageRoot}/lib/types/ink/hooks/use-declared-cursor.js`
    const hookModule = createRequire(import.meta.url)(hookPath) as {
      useDeclaredCursor?: UseDeclaredCursor
      useNativeCursor?: UseNativeCursor
      default?: { useDeclaredCursor?: UseDeclaredCursor; useNativeCursor?: UseNativeCursor }
    }
    const declared = hookModule.useDeclaredCursor ?? hookModule.default?.useDeclaredCursor
    const native = hookModule.useNativeCursor ?? hookModule.default?.useNativeCursor
    return {
      ...(typeof declared === 'function' ? { useDeclaredCursor: declared } : {}),
      ...(typeof native === 'function' ? { useNativeCursor: native } : {}),
    }
  } catch {
    return {}
  }
}

/** The fallback hooks, loaded once (permanent degrade when unreachable). */
const vendored: HostCursorKit = loadVendoredHooks()

/**
 * Declares the caret for one box and reports whether the terminal paints it.
 *
 * The implementation is chosen per MOUNT, not per render: `kit` is the host's
 * ui namespace (a scene) or the panel adapter's memoized kit, and neither can
 * change shape while the component lives — so the hook count is constant, as
 * React requires. A kit that carries only half the pair (never seen in a real
 * host, where both come from one export line) falls back as a whole.
 */
export function useHostCursor(kit: HostCursorKit | undefined, options: HostCursorOptions): HostCursor {
  const kitDeclare = kit?.useDeclaredCursor
  const kitNative = kit?.useNativeCursor
  const chosen: HostCursorKit =
    typeof kitDeclare === 'function' && typeof kitNative === 'function' ? { useDeclaredCursor: kitDeclare, useNativeCursor: kitNative } : vendored
  const native = chosen.useNativeCursor !== undefined ? chosen.useNativeCursor() : false
  const declare = chosen.useDeclaredCursor
  const ref = declare === undefined ? undefined : declare({
    line: options.line,
    column: options.column,
    active: options.active,
    visible: options.visible === true && native,
  })
  return { ref, native }
}
