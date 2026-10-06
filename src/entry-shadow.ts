/**
 * Which scene binding a global-entry combo SHADOWS.
 *
 * The entry is a toggle and its closing half is the scene's first branch
 * (find-input.ts): the combo that opened the search UI closes it before any
 * other branch can run. For most combos that costs nothing — a combo carries
 * ctrl or alt, and the scene's own vocabulary is modifier-free typing plus a
 * handful of chords. But the `shortcut` row accepts combos the scene ALSO
 * answers (`alt+h` is the help chord, `alt+c` the copy chord, `ctrl+tab` the
 * scope switch, and `alt+backspace` a branch with no modifier gate at all),
 * and the host's registry reserves none of THOSE (`alt+r` is the exception —
 * it is the host's own Continue action, so a remap onto it is refused before
 * this table ever matters): the entry keeps working and the scene's own action
 * for that key disappears while the scene is open.
 *
 * This module names that overlap so the two user-visible surfaces can say so:
 * main.tsx warns once per accepted binding (log + toast) and the help sheet
 * marks the row whose key the entry has taken (help.tsx). Detection mirrors
 * the dispatcher's branches gate for gate:
 *
 * - the seven `alt+<letter>` chords are gated on `altOnly`
 *   (`meta && !ctrl && !super`) and compare the lowercased input, so only an
 *   alt-without-ctrl combo reaches them;
 * - `Tab`, the arrows, the page keys and `Backspace`/`Delete` carry no
 *   modifier gate at all, so ANY combo spelling them reaches the branch;
 * - `Enter` is unreachable (`isPlainReturn` refuses modifiers, and a combo
 *   always carries one) and escape combos are refused by the grammar itself
 *   (shortcut-combo.ts), so neither can shadow anything.
 *
 * A combo carrying SHIFT is never reported (R-164). The branches above ignore
 * shift while the toggle matches the combo strictly (`matchesShortcut`
 * compares the flag), so `alt+shift+h` exits on exactly that spelling while
 * plain `Alt+H` — the one the sheet prints — still opens the sheet. Marking
 * that row as taken would be a claim the user can watch fail; what such a combo
 * takes is its own spelling, i.e. the toggle working as configured.
 *
 * Adding a chord to the scene's dispatcher therefore means adding it here too:
 * test/entry-shadow.test.ts pins each row against the matcher and the branch
 * gate it claims, and test/scene.test.ts pins the shadowing itself on the real
 * dispatcher.
 *
 * @module dsh-tui-find/entry-shadow
 */
import type { I18nKey } from './i18n.js'
import { parseShortcutCombo, type ShortcutNamedKey } from './shortcut-combo.js'

/** One scene binding a global-entry combo can take over. */
export interface SceneKeyShadow {
  /** The help sheet's keys cell for the shadowed binding (`Alt+H`), or
   *  undefined when the sheet has no row for that key at all
   *  (`Backspace`/`Delete`: the sheet never listed them). The sheet uses this
   *  to mark the row; the toast does not need it. */
  readonly helpKeys: string | undefined
  /** i18n key naming the scene action that stops responding (`help-list-*`
   *  wherever the sheet has a row: the two surfaces must name one action). */
  readonly actionKey: I18nKey
}

/** The scene's own Alt+<letter> chords: one shadow per letter, spelled the way
 *  the help sheet spells it. */
const ALT_CHORD_SHADOWS = new Map<string, SceneKeyShadow>([
  ['h', { helpKeys: 'Alt+H', actionKey: 'help-list-help' }],
  ['r', { helpKeys: 'Alt+R', actionKey: 'help-list-regex' }],
  ['t', { helpKeys: 'Alt+T', actionKey: 'help-list-time' }],
  ['n', { helpKeys: 'Alt+N', actionKey: 'help-list-title-only' }],
  ['p', { helpKeys: 'Alt+P', actionKey: 'help-list-preview' }],
  ['c', { helpKeys: 'Alt+C', actionKey: 'help-list-copy' }],
  ['e', { helpKeys: 'Alt+E', actionKey: 'help-list-expand' }],
])

/** The named keys the dispatcher answers without a modifier gate. `↑`/`↓`
 *  share one sheet row, and `←`/`→` are the split layout's focus pair. */
const NAMED_KEY_SHADOWS = new Map<ShortcutNamedKey, SceneKeyShadow>([
  ['tab', { helpKeys: 'Tab', actionKey: 'help-list-scope' }],
  ['upArrow', { helpKeys: '↑↓', actionKey: 'help-list-select' }],
  ['downArrow', { helpKeys: '↑↓', actionKey: 'help-list-select' }],
  ['leftArrow', { helpKeys: '←', actionKey: 'help-preview-focus' }],
  ['rightArrow', { helpKeys: '→', actionKey: 'help-list-read-split' }],
  ['pageUp', { helpKeys: 'PgUp/PgDn', actionKey: 'help-list-page' }],
  ['pageDown', { helpKeys: 'PgUp/PgDn', actionKey: 'help-list-page' }],
  ['backspace', { helpKeys: undefined, actionKey: 'scene-key-backspace' }],
  ['delete', { helpKeys: undefined, actionKey: 'scene-key-backspace' }],
])

/**
 * The scene binding `combo` takes over inside the scene, or undefined when the
 * combo is free (the common case: `alt+f` and every `ctrl+<letter>` the scene
 * does not answer) or carries shift (R-164: it takes its own spelling, never
 * the shift-free one the sheet prints). An unusable combo shadows nothing — it
 * never becomes a binding in the first place (see resolveShortcut).
 */
export function sceneKeyShadow(combo: string | undefined): SceneKeyShadow | undefined {
  if (combo === undefined) return undefined
  const parsed = parseShortcutCombo(combo)
  if (parsed === undefined) return undefined
  // R-164: the shift-free spelling is the one every user-visible surface names,
  // and the scene's branches answer it whatever shift does.
  if (parsed.shift) return undefined
  if (parsed.named !== undefined) return NAMED_KEY_SHADOWS.get(parsed.named)
  if (parsed.char === undefined) return undefined
  // The Alt chords are `altOnly`: ctrl (or a bare alt-less combo, which the
  // grammar already refused) never reaches those branches.
  if (!parsed.alt || parsed.ctrl) return undefined
  return ALT_CHORD_SHADOWS.get(parsed.char)
}
