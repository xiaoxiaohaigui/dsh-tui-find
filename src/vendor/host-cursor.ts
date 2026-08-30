/**
 * Defensive bridge to the host's `useDeclaredCursor` hook (not exported on
 * the plugin-facing ui kit): declaring the native terminal cursor position
 * after each frame is what parks the IME preedit INLINE at the search box
 * caret instead of at the screen bottom — the difference between typing
 * Chinese into the search card and typing it into a floating bar at the
 * bottom edge. The host's own SearchBox does this for /resume; this bridge
 * gives the find scene the same behaviour.
 *
 * Loaded ONCE at module scope, synchronously, so the hooks rule stays
 * intact: a scene either always calls the hook or never does — a hook that
 * appears mid-lifetime would change the hook count between renders and kill
 * the reconciler. Loading goes through the host package's internal file
 * layout (its `exports` map does not expose the hook subpath); any failure
 * — unexpected package layout, a Node without require-of-ESM, a renamed
 * hook — degrades permanently to no cursor declaration, which is the
 * pre-fix status quo: the scene stays fully functional.
 *
 * @module dsh-tui-find/vendor/host-cursor
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

type UseDeclaredCursor = (options: {
  line: number
  column: number
  active: boolean
}) => (node: object | null) => void

function loadHostCursorHook(): UseDeclaredCursor | undefined {
  try {
    // The host package's `exports` map carries only import conditions, so
    // the entry must be resolved through ESM's resolver (CJS require.resolve
    // rejects it) — then the hook file itself is loaded through a plain
    // require, which Node reads synchronously even for an ESM file.
    const entryUrl = import.meta.resolve('@deepseek-harness-tui/dsh-tui')
    const packageRoot = fileURLToPath(entryUrl).replace(/[\\/]lib[\\/]types[\\/].*$/, '')
    const hookPath = `${packageRoot}/lib/types/ink/hooks/use-declared-cursor.js`
    const hookModule = createRequire(import.meta.url)(hookPath) as {
      useDeclaredCursor?: UseDeclaredCursor
      default?: { useDeclaredCursor?: UseDeclaredCursor }
    }
    const hook = hookModule.useDeclaredCursor ?? hookModule.default?.useDeclaredCursor
    return typeof hook === 'function' ? hook : undefined
  } catch {
    return undefined
  }
}

/** The host hook when reachable, undefined otherwise (permanent degrade). */
export const useHostDeclaredCursor: UseDeclaredCursor | undefined = loadHostCursorHook()
