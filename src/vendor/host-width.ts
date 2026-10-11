/**
 * Defensive bridge to the host's `stringWidth` — the measurement the host lays
 * its OWN rows out with, and therefore the only one that may be used where a
 * plugin tells the host where something is. The panel's IME cursor declaration
 * is exactly such a place: the host parks the terminal cursor at the column the
 * panel names, while the row it names it for is painted by the host's renderer
 * with the host's width model (R-172). The repo's own table (`src/width.ts`) is
 * a close approximation — it is what the list's truncation budgets are built on
 * — but it disagrees with the host on combining marks and emoji (measured:
 * `a\u0301` host 1 / repo 2, `⭐` host 2 / repo 1, `🏳️‍🌈` host 2 / repo 6), and
 * one column is the difference between a candidate window at the caret and one
 * cell off it.
 *
 * Loaded ONCE at module scope, through the host package's internal file layout
 * (`stringWidth` is not part of the plugin-facing kit, and the package's
 * `exports` map carries no subpath for it) — the `host-cursor.ts` precedent.
 * Any failure degrades to `undefined`, and callers fall back to the repo table:
 * the pre-fix behaviour, fully functional, just off by a column on those
 * characters.
 *
 * @module dsh-tui-find/vendor/host-width
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

function loadHostStringWidth(): ((text: string) => number) | undefined {
  try {
    // The host's `exports` map carries only import conditions, so the entry
    // must be resolved through ESM's resolver (CJS require.resolve rejects it);
    // the module itself is then loaded through a plain require, which Node
    // reads synchronously even for an ESM file.
    const entryUrl = import.meta.resolve('@deepseek-harness-tui/dsh-tui')
    const packageRoot = fileURLToPath(entryUrl).replace(/[\\/]lib[\\/]types[\\/].*$/, '')
    const module = createRequire(import.meta.url)(`${packageRoot}/lib/types/ink/stringWidth.js`) as {
      stringWidth?: (text: string) => number
      default?: { stringWidth?: (text: string) => number }
    }
    const width = module.stringWidth ?? module.default?.stringWidth
    return typeof width === 'function' ? width : undefined
  } catch {
    return undefined
  }
}

/** The host's width function when reachable, undefined otherwise (permanent
 *  degrade to `src/width.ts`'s table at the call sites). */
export const hostStringWidth: ((text: string) => number) | undefined = loadHostStringWidth()
