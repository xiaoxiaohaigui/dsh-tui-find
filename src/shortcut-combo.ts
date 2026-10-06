/**
 * The global-entry combo's grammar, its keypress matcher and its display
 * form — one vocabulary shared by the settings row validation (config.ts)
 * and the scene's own key dispatcher (find-input.ts).
 *
 * Why the scene matches the combo itself: the host's `tuiShortcuts` registry
 * dispatches only in the plain chat state — `Chat.tsx`'s `useInput` yields
 * the whole keyboard to a plugin scene (`if (sceneOpen ||
 * channel.pluginScene !== undefined) return`), so while /find holds the
 * screen the registered handler is never called. Answering the combo here is
 * what makes the global entry a TOGGLE: the key that opened the search UI
 * closes it again, and because the scene matches the SAME resolved combo the
 * host bound, a remap in the `shortcut` config moves both halves together
 * (a hardcoded Alt+F would toggle nothing for a remapped user).
 *
 * The grammar mirrors the host's `utils/keymap.ts` (`parseCombo` /
 * `comboMatchesStrict`), structurally rather than by import: the host's
 * keymap is not part of the plugin API surface this package may depend on
 * (docs/decisions/2026-09-12-dual-version-compat-strategy.md). Modifiers are
 * ctrl/alt(/shift) with `control`/`meta`/`option` aliases; the key is one
 * code point or one of the host's named keys; a combo must carry ctrl or
 * alt; Escape combos are refused (every Escape arrives with meta set on the
 * input layer, so an escape combo could never be unambiguous).
 *
 * @module dsh-tui-find/shortcut-combo
 */
import type { InputKey } from './find-types.js'

/** The ink key flags a named combo key addresses. */
export type ShortcutNamedKey =
  | 'return'
  | 'escape'
  | 'tab'
  | 'backspace'
  | 'delete'
  | 'upArrow'
  | 'downArrow'
  | 'leftArrow'
  | 'rightArrow'
  | 'home'
  | 'end'
  | 'pageUp'
  | 'pageDown'

/**
 * Named keys and the ink key flag each one sets — the host's own `NAMED_KEYS`
 * table (src/utils/keymap.ts), kept as a Map so a key name that collides with
 * an `Object.prototype` member (`constructor`, `toString`) can never be
 * mistaken for a named key.
 */
const NAMED_KEYS = new Map<string, ShortcutNamedKey>([
  ['enter', 'return'],
  ['return', 'return'],
  ['esc', 'escape'],
  ['escape', 'escape'],
  ['tab', 'tab'],
  ['backspace', 'backspace'],
  ['delete', 'delete'],
  ['up', 'upArrow'],
  ['down', 'downArrow'],
  ['left', 'leftArrow'],
  ['right', 'rightArrow'],
  ['home', 'home'],
  ['end', 'end'],
  ['pageup', 'pageUp'],
  ['pagedown', 'pageDown'],
])

/** Established spellings for the help sheet's language-free keys column: the
 *  scene's hint lines own this vocabulary (`↑↓`, `PgUp/PgDn`, `Alt+P`) and
 *  the sheet repeats it, so a remapped combo reads in the same alphabet. */
const NAMED_KEY_LABELS: Record<ShortcutNamedKey, string> = {
  return: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  upArrow: '↑',
  downArrow: '↓',
  leftArrow: '←',
  rightArrow: '→',
  home: 'Home',
  end: 'End',
  pageUp: 'PgUp',
  pageDown: 'PgDn',
}

/** A combo in the host grammar's terms. */
export interface ShortcutCombo {
  readonly ctrl: boolean
  /** `alt` is the ink `meta` flag (the host maps Alt onto it). */
  readonly alt: boolean
  readonly shift: boolean
  /** The key flag for a named key, or undefined for a character key. */
  readonly named: ShortcutNamedKey | undefined
  /** The lowercased character key (`' '` for `space`), or undefined for a
   *  named key. */
  readonly char: string | undefined
}

/**
 * Parse one `ctrl+shift+p` style combo. Anything the host grammar refuses
 * (no ctrl/alt, unknown key name, repeated modifier, escape combo, trailing
 * `+`) answers undefined rather than throwing — every caller here treats
 * that as "not a binding".
 */
export function parseShortcutCombo(raw: string): ShortcutCombo | undefined {
  const parts = String(raw ?? '')
    .toLowerCase()
    .split('+')
    .map(part => part.trim())
    .filter(part => part !== '')
  let ctrl = false
  let alt = false
  let shift = false
  let named: ShortcutNamedKey | undefined
  let char: string | undefined
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') {
      if (ctrl) return undefined
      ctrl = true
    } else if (part === 'alt' || part === 'meta' || part === 'option') {
      if (alt) return undefined
      alt = true
    } else if (part === 'shift') {
      if (shift) return undefined
      shift = true
    } else if (part === 'space') {
      if (char !== undefined || named !== undefined) return undefined
      char = ' '
    } else if (NAMED_KEYS.has(part)) {
      if (char !== undefined || named !== undefined) return undefined
      named = NAMED_KEYS.get(part)
    } else if ([...part].length === 1) {
      if (char !== undefined || named !== undefined) return undefined
      char = part
    } else {
      return undefined
    }
  }
  if (char === undefined && named === undefined) return undefined
  // Bare keys are typing/navigation; a modifier is what makes a shortcut.
  if (!ctrl && !alt) return undefined
  if (named === 'escape') return undefined
  return { ctrl, alt, shift, named, char }
}

/**
 * Whether `combo` is structurally usable — the host registry's registration
 * grammar (reserved combos remain the registry's concern, it re-checks them
 * against the live keymap). Used by the `shortcut` row validation, so a typo
 * is reported instead of silently dropping the global entry.
 */
export function isPlausibleShortcut(combo: string): boolean {
  return parseShortcutCombo(combo) !== undefined
}

/**
 * Whether one parsed keypress is exactly `combo` — the host's strict
 * plugin-registry semantics (`comboMatchesStrict`): every modifier flag must
 * equal the combo's, `super` (Cmd) never matches, and a character key
 * compares against the lowercased input, so Shift+Alt+C arrives as meta +
 * `'C'` and still matches `alt+c`.
 */
export function matchesShortcut(combo: string, input: string, key: InputKey): boolean {
  const parsed = parseShortcutCombo(combo)
  if (parsed === undefined) return false
  if (Boolean(key.ctrl) !== parsed.ctrl) return false
  if (Boolean(key.meta) !== parsed.alt) return false
  if (key.super === true) return false
  if (Boolean(key.shift) !== parsed.shift) return false
  if (parsed.named !== undefined) return key[parsed.named] === true
  if (parsed.char === undefined) return false
  return input.toLowerCase() === parsed.char
}

/**
 * The combo as the help sheet spells keys: `alt+f` → `Alt+F`,
 * `ctrl+shift+return` → `Ctrl+Shift+Enter`, `alt+space` → `Alt+Space`.
 * An unparseable value comes back exactly as read rather than hidden or
 * blanked: the sheet's job is to name what the config says, and the settings
 * card already refuses drafts the grammar rejects.
 */
export function formatShortcut(combo: string): string {
  const parsed = parseShortcutCombo(combo)
  if (parsed === undefined) return combo
  return [
    ...(parsed.ctrl ? ['Ctrl'] : []),
    ...(parsed.alt ? ['Alt'] : []),
    ...(parsed.shift ? ['Shift'] : []),
    parsed.named !== undefined
      ? NAMED_KEY_LABELS[parsed.named]
      : parsed.char === ' '
        ? 'Space'
        : (parsed.char ?? '').toUpperCase(),
  ].join('+')
}
