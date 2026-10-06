/**
 * The global-entry combo's grammar, matcher and display form.
 *
 * These are the pieces that make the entry a TOGGLE: the host registry binds
 * the combo in the plain chat state, and the scene matches the SAME combo
 * itself while it owns the keyboard (the host never dispatches there — see
 * src/shortcut-combo.ts). Both halves read one grammar, so a remap moves them
 * together and a value the host would refuse can never become a binding.
 *
 * The accept/reject table mirrors the host's own parser
 * (`dsh-tui/lib/types/utils/keymap.js`, `parseCombo` / `comboMatchesStrict`),
 * which is what the registry re-checks a registration against.
 */
import { describe, expect, it } from 'vitest'
import type { InputKey } from '../src/find-types.js'
import {
  formatShortcut,
  isPlausibleShortcut,
  matchesShortcut,
  parseShortcutCombo,
} from '../src/shortcut-combo.js'

/** One host-parsed keypress: the flags under test, typed onto the ink Key
 *  shape the host hands a useInput handler. */
function keypress(flags: {
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  super?: boolean
  return?: boolean
  escape?: boolean
  tab?: boolean
  upArrow?: boolean
  leftArrow?: boolean
  pageUp?: boolean
}): InputKey {
  return flags as InputKey
}

describe('parseShortcutCombo (host combo grammar)', () => {
  it('parses modifiers and a character key', () => {
    expect(parseShortcutCombo('alt+f')).toEqual({ ctrl: false, alt: true, shift: false, named: undefined, char: 'f' })
    expect(parseShortcutCombo('Ctrl+Alt+G')).toEqual({ ctrl: true, alt: true, shift: false, named: undefined, char: 'g' })
  })

  it('accepts the host aliases: control/meta/option, named keys, space', () => {
    expect(parseShortcutCombo('control+meta+k')).toMatchObject({ ctrl: true, alt: true, char: 'k' })
    expect(parseShortcutCombo('option+home')).toMatchObject({ alt: true, named: 'home', char: undefined })
    expect(parseShortcutCombo('ctrl+pageup')).toMatchObject({ ctrl: true, named: 'pageUp' })
    expect(parseShortcutCombo('alt+space')).toMatchObject({ alt: true, char: ' ' })
    // enter/return and esc/escape are name pairs for one key.
    expect(parseShortcutCombo('alt+return')).toMatchObject({ named: 'return' })
    expect(parseShortcutCombo('alt+enter')).toMatchObject({ named: 'return' })
  })

  it('refuses what the registry refuses', () => {
    // No ctrl/alt: bare keys are typing/navigation, not shortcuts.
    expect(parseShortcutCombo('f')).toBeUndefined()
    expect(parseShortcutCombo('shift+f')).toBeUndefined()
    // Escape is fully owned by the TUI (it always arrives with meta set).
    expect(parseShortcutCombo('ctrl+escape')).toBeUndefined()
    // Malformed shapes.
    expect(parseShortcutCombo('ctrl+')).toBeUndefined()
    expect(parseShortcutCombo('')).toBeUndefined()
    expect(parseShortcutCombo('ctrl+f5')).toBeUndefined()
    expect(parseShortcutCombo('ctrl+unknown')).toBeUndefined()
    expect(parseShortcutCombo('ctrl+ctrl+f')).toBeUndefined()
    expect(parseShortcutCombo('ctrl+alt+g+h')).toBeUndefined()
  })

  it('cannot mistake an Object.prototype member for a named key', () => {
    // The host's table is a plain object and `part in NAMED_KEYS` is true for
    // 'constructor'; this parser rides a Map, so the value can never become a
    // function masquerading as a key flag.
    expect(parseShortcutCombo('ctrl+constructor')).toBeUndefined()
    expect(parseShortcutCombo('ctrl+toString')).toBeUndefined()
  })

  it('answers isPlausibleShortcut for the settings row', () => {
    expect(isPlausibleShortcut('alt+f')).toBe(true)
    expect(isPlausibleShortcut('ctrl+home')).toBe(true)
    expect(isPlausibleShortcut('shift+return')).toBe(false)
    expect(isPlausibleShortcut('ctrl+unknown')).toBe(false)
  })
})

describe('matchesShortcut (strict keypress match)', () => {
  it('matches the character key with exactly its modifiers', () => {
    expect(matchesShortcut('alt+f', 'f', keypress({ meta: true }))).toBe(true)
    // Shift+Alt+C arrives as meta + 'C' and still matches the lowercase combo.
    expect(matchesShortcut('alt+c', 'C', keypress({ meta: true, shift: false }))).toBe(true)
    // Every modifier flag must equal the combo's.
    expect(matchesShortcut('alt+f', 'f', keypress({}))).toBe(false)
    expect(matchesShortcut('alt+f', 'f', keypress({ meta: true, ctrl: true }))).toBe(false)
    expect(matchesShortcut('alt+f', 'f', keypress({ meta: true, shift: true }))).toBe(false)
    // Cmd (super) is not part of the registry grammar.
    expect(matchesShortcut('alt+f', 'f', keypress({ meta: true, super: true }))).toBe(false)
    // A different key is a different key.
    expect(matchesShortcut('alt+f', 'g', keypress({ meta: true }))).toBe(false)
    // A multi-key chunk can never match a single-key combo.
    expect(matchesShortcut('alt+f', 'fx', keypress({ meta: true }))).toBe(false)
  })

  it('matches named keys by their flag', () => {
    expect(matchesShortcut('ctrl+home', '', keypress({ ctrl: true }))).toBe(false)
    expect(matchesShortcut('ctrl+pageup', '', keypress({ ctrl: true, pageUp: true }))).toBe(true)
    expect(matchesShortcut('ctrl+up', '', keypress({ ctrl: true, upArrow: true }))).toBe(true)
    expect(matchesShortcut('ctrl+up', '', keypress({ ctrl: true, leftArrow: true }))).toBe(false)
    // Escape arrives with meta set on the host's input layer; it may never be
    // captured by an alt combo (the grammar refuses escape combos, and the
    // char compare keeps the bare key out of a character binding too).
    expect(matchesShortcut('alt+f', '', keypress({ meta: true, escape: true }))).toBe(false)
  })

  it('never matches an unusable combo', () => {
    expect(matchesShortcut('off', 'f', keypress({ meta: true }))).toBe(false)
    expect(matchesShortcut('f', 'f', keypress({}))).toBe(false)
    expect(matchesShortcut('ctrl+unknown', '', keypress({ ctrl: true }))).toBe(false)
  })
})

describe('formatShortcut (help-sheet spelling)', () => {
  it('spells modifiers and keys the way the sheet and hints do', () => {
    expect(formatShortcut('alt+f')).toBe('Alt+F')
    expect(formatShortcut('ctrl+alt+g')).toBe('Ctrl+Alt+G')
    expect(formatShortcut('ctrl+shift+return')).toBe('Ctrl+Shift+Enter')
    expect(formatShortcut('alt+space')).toBe('Alt+Space')
    expect(formatShortcut('ctrl+home')).toBe('Ctrl+Home')
    expect(formatShortcut('ctrl+pageup')).toBe('Ctrl+PgUp')
    expect(formatShortcut('ctrl+left')).toBe('Ctrl+←')
  })

  it('hands back an unusable value as read instead of blanking the sheet', () => {
    expect(formatShortcut('f')).toBe('f')
    expect(formatShortcut('watch out')).toBe('watch out')
  })
})
