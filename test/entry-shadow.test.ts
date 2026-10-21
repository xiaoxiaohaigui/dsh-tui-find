/**
 * The entry-vs-scene key overlap (REVIEW R-160): the global entry's closing
 * half is the scene's FIRST branch (find-input.ts), so a `shortcut` value that
 * is also a key the scene answers keeps the entry but loses that scene key —
 * and the host's registry reserves none of these combos, so nothing upstream
 * stops the user from configuring one.
 *
 * The table is only useful if it is honest, so these tests pin it against the
 * two things that make a "shadow" real:
 *
 * 1. the entry matcher accepts the keypress the shadowed branch gates on
 *    (shortcut-combo.ts's strict matcher, the same one the scene dispatches
 *    with), and
 * 2. the help sheet really has the row the shadow names — otherwise the
 *    marker the sheet appends would never be painted anywhere,
 *
 * and that no shadow is claimed for a SHIFT-carrying combo (R-164): the row
 * these surfaces name is then still doing what the sheet says.
 *
 * The behavior itself (the entry winning over the scene's own chord) is pinned
 * on the real dispatcher in test/scene.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SHORTCUT } from '../src/config.js'
import { sceneKeyShadow } from '../src/entry-shadow.js'
import type { InputKey } from '../src/find-types.js'
import { helpSections } from '../src/help.js'
import { dict } from '../src/i18n.js'
import { matchesShortcut } from '../src/shortcut-combo.js'

/** One host-parsed keypress: the ink flags under test, typed onto the shape
 *  the host hands a useInput handler. */
type KeyFlags = {
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  super?: boolean
  tab?: boolean
  backspace?: boolean
  delete?: boolean
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  pageUp?: boolean
  pageDown?: boolean
}
const keypress = (flags: KeyFlags): InputKey => flags as InputKey

/** Every key cell the sheet paints, classic layout. */
const sheetKeys = (): string[] =>
  helpSections(100, false, DEFAULT_SHORTCUT).flatMap(section => section.rows.map(row => row.keys))

describe('sceneKeyShadow', () => {
  it('names every Alt chord the scene dispatches (the altOnly branches)', () => {
    // The seven chords the list/help/preview layers answer. Each one matches
    // through the entry matcher as an Alt keypress — that is exactly why the
    // toggle branch, which runs before them, can take the key.
    const chords: Array<[string, string]> = [
      ['alt+h', 'Alt+H'],
      ['alt+r', 'Alt+R'],
      ['alt+t', 'Alt+T'],
      ['alt+n', 'Alt+N'],
      ['alt+p', 'Alt+P'],
      ['alt+c', 'Alt+C'],
      ['alt+e', 'Alt+E'],
    ]
    for (const [combo, keys] of chords) {
      const shadow = sceneKeyShadow(combo)
      expect(shadow, combo).toBeDefined()
      expect(shadow?.helpKeys).toBe(keys)
      // Shift+Alt+C arrives as meta + 'C' and still reaches the scene's
      // `altOnly && lower === 'c'` branch — as does the entry matcher, which is
      // what makes the collision real for the SHIFT-FREE combo. A shift-carrying
      // combo is a different spelling of the same chord and is deliberately not
      // reported: see the R-164 test below.
      expect(matchesShortcut(combo, keys.slice(-1), keypress({ meta: true }))).toBe(true)
    }
  })

  it('reports nothing for a shift-carrying combo: the printed key still works (R-164)', () => {
    // The toggle matches the combo STRICTLY (matchesShortcut compares shift)
    // while the scene's own branches ignore it. So `alt+shift+h` exits the scene
    // on exactly that spelling, and the key every surface prints — `Alt+H` — is
    // untouched: naming it as taken would be a claim the user can watch fail.
    for (const combo of [
      'alt+shift+h',
      'alt+shift+e',
      'ctrl+shift+tab',
      'alt+shift+up',
      'ctrl+shift+backspace',
    ]) {
      expect(sceneKeyShadow(combo), combo).toBeUndefined()
    }
    // What the combo takes is its own spelling — the toggle working as
    // configured, not a collision with the scene's key.
    expect(matchesShortcut('alt+shift+h', 'h', keypress({ meta: true, shift: true }))).toBe(true)
    expect(matchesShortcut('alt+shift+h', 'h', keypress({ meta: true }))).toBe(false)
    // …and the shift-free twin is still reported, so the gate cannot quietly
    // swallow the collision it exists for.
    expect(sceneKeyShadow('alt+h')?.helpKeys).toBe('Alt+H')
  })

  it('names the ungated navigation keys any combo can reach', () => {
    // Tab / arrows / page keys / Backspace+Delete carry no modifier gate in
    // the dispatcher, so a ctrl+… entry reaches them just as an alt+… one does.
    const named: Array<[string, KeyFlags, string | undefined]> = [
      ['ctrl+tab', { ctrl: true, tab: true }, 'Tab'],
      ['alt+up', { meta: true, upArrow: true }, '↑↓'],
      ['ctrl+down', { ctrl: true, downArrow: true }, '↑↓'],
      ['ctrl+left', { ctrl: true, leftArrow: true }, '←'],
      ['ctrl+right', { ctrl: true, rightArrow: true }, '→'],
      ['ctrl+pageup', { ctrl: true, pageUp: true }, 'PgUp/PgDn'],
      ['ctrl+pagedown', { ctrl: true, pageDown: true }, 'PgUp/PgDn'],
      // The sheet never listed Backspace/Delete: the shadow is real, the
      // annotation has no row to land on (only the toast names it).
      ['alt+backspace', { meta: true, backspace: true }, undefined],
      ['ctrl+delete', { ctrl: true, delete: true }, undefined],
      ['ctrl+alt+tab', { ctrl: true, meta: true, tab: true }, 'Tab'],
    ]
    for (const [combo, flags, keys] of named) {
      const shadow = sceneKeyShadow(combo)
      expect(shadow, combo).toBeDefined()
      expect(shadow?.helpKeys, combo).toBe(keys)
      expect(matchesShortcut(combo, '', keypress(flags)), combo).toBe(true)
    }
  })

  it("names both jobs of split's ← in the shadow toast (R-189)", () => {
    // ← is context-dependent: it returns from the reader and enters the
    // workspace column from the list. The toast names both instead of the
    // old reader-only copy.
    expect(sceneKeyShadow('ctrl+left')?.actionKey).toBe('scene-key-left-arrow')
  })

  it('leaves free combos alone', () => {
    // The default entry, the other ctrl letters the scene never answers, a
    // combo whose key the scene does not handle at all, and — importantly —
    // an Alt chord the scene cannot reach because ctrl is held with it.
    for (const combo of [
      DEFAULT_SHORTCUT,
      'alt+g',
      'ctrl+v',
      'ctrl+alt+g',
      'ctrl+home',
      'alt+space',
      'ctrl+alt+h',
      'alt+enter',
      'alt+escape',
      'ctrl+f5',
      'off',
      'f',
      '',
    ]) {
      expect(sceneKeyShadow(combo), combo).toBeUndefined()
    }
    expect(sceneKeyShadow(undefined)).toBeUndefined()
  })

  it('names an i18n action that exists, so the toast never prints a raw key', () => {
    // t() renders the key itself on a miss, which would ship "help-list-xyz"
    // to the user's toast.
    for (const combo of ['alt+h', 'alt+r', 'alt+t', 'alt+n', 'alt+p', 'alt+c', 'alt+e', 'ctrl+tab', 'ctrl+up', 'ctrl+left', 'ctrl+right', 'ctrl+pageup', 'alt+backspace']) {
      const actionKey = sceneKeyShadow(combo)?.actionKey
      expect(actionKey, combo).toBeDefined()
      expect(Object.keys(dict), actionKey).toContain(actionKey)
    }
  })

  it('names only help rows the sheet actually paints', () => {
    // The sheet appends its marker by comparing this cell against its own row
    // keys: a spelling that matches no row would be a silently dead marker.
    const painted = sheetKeys()
    for (const combo of ['alt+h', 'alt+r', 'alt+t', 'alt+n', 'alt+p', 'alt+c', 'alt+e', 'ctrl+tab', 'ctrl+up', 'ctrl+pageup']) {
      const helpKeys = sceneKeyShadow(combo)?.helpKeys
      expect(helpKeys, combo).toBeDefined()
      expect(painted, `${combo} → ${helpKeys}`).toContain(helpKeys)
    }
  })
})
