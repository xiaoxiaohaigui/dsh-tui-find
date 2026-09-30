/**
 * Static cost screen for the regex mode (REVIEW R-099).
 *
 * Why a screen at all: regex matching runs SYNCHRONOUSLY inside the scene's
 * render-time memo, once per indexed document, with no timeout, no yield and
 * no cancellation — a JavaScript `RegExp` cannot be interrupted. A pattern
 * whose backtracking is catastrophic therefore does not "take long": it
 * freezes the host TUI until the terminal is killed. The plugin's only lever
 * is refusing to compile such a pattern in the first place.
 *
 * Why not the old four-regex heuristic: it only knew four shapes
 * (backreferences, quantified groups containing a quantifier, quantified
 * alternation, any group followed by a brace quantifier) and missed the
 * "spread repetition" family entirely — `.*.*.*z` and
 * `a*a*a*a*a*a*a*a*b` both passed it and both hang the UI on short input
 * (measured: `.*.*.*z` on 500 characters did not finish within 3 s; the
 * eight-`a*` pattern did not finish within 5 minutes on 100 characters).
 *
 * What is modelled here instead: the pattern is scanned as a nested sequence
 * of atoms, each carrying a conservative FIRST-CHARACTER set, and the screen
 * rejects every pair of "stretchy" atoms (an unbounded repetition, or one
 * whose bound spans at least three lengths) that can be reached by each
 * other. Two stretchy atoms are ambiguous when their first-character sets
 * intersect AND nothing mandatory sits between them OR something between them
 * can be swallowed by the earlier one — the exact shape of a backtracking
 * split. `.*a.*b` is ambiguous because the first `.*` can eat the `a`;
 * `\w+@\w+\.\w+` is not, because no `\w` can match the `@` that pins the
 * boundary; `a*a*a*b` is, because the second `a*` starts where the first may
 * stop. That distinction is what keeps ordinary patterns (`\d+\w*`,
 * `ab{2,3}`, `re\w*ry|jitter`, `(foo|bar)baz`) allowed while the hang family
 * is refused.
 *
 * The sets are an under-approximation of the atoms' real languages, so an
 * unmodelled construct (a group's interior, an exotic escape, a negated
 * class) is reported as "matches anything" — the direction that only ever
 * makes the screen MORE suspicious. Every rejection is therefore
 * deterministic and explainable, and no accepted pattern can be proven safe:
 * the screen removes the known catastrophic families, it is not a proof.
 *
 * @module dsh-tui-find/core/regex-guard
 */

/** The screen's verdict for one raw pattern. */
export type RegexGuardVerdict = 'ok' | 'unsafe'

/** A first-character set: the code units an atom can start a match with.
 *  `undefined` is the "matches anything" top — used for wildcards, negated
 *  classes and anything the scan cannot model — and `EMPTY` is the zero-width
 *  atom (an anchor, a lookaround). */
type FirstChars = ReadonlySet<number> | undefined

const EMPTY: ReadonlySet<number> = new Set<number>()

/** `\d`, spelled out: a set is what makes `\d+\.\d+` decidable. */
const DIGITS: ReadonlySet<number> = units('0123456789')
/** `\w`. */
const WORD: ReadonlySet<number> = units('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_')
/** `\s` (ECMAScript WhiteSpace + LineTerminator). */
const SPACES: ReadonlySet<number> = units(' \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')

/** How large a character-class range may expand before it is treated as
 *  "anything": the sets exist to be intersected, and a 65k-entry set costs
 *  more than the conservative verdict it would buy. */
const RANGE_EXPAND_LIMIT = 256

function units(text: string): ReadonlySet<number> {
  const set = new Set<number>()
  for (let at = 0; at < text.length; at++) set.add(text.charCodeAt(at))
  return set
}

/** Whether two first-character sets share a unit. An unmodelled set
 *  (`undefined`) shares with everything. */
function overlaps(left: FirstChars, right: FirstChars): boolean {
  if (left === undefined || right === undefined) return true
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  for (const unit of small) {
    if (large.has(unit)) return true
  }
  return false
}

/** One repetition suffix: `{min,max}` bounds (`Infinity` = unbounded) and
 *  whether it was written with braces — the two legacy verdicts key off that
 *  flag (a brace-quantified group is refused outright, see {@link note}). */
interface Repetition {
  readonly min: number
  readonly max: number
  readonly brace: boolean
  readonly next: number
}

/** One parsed atom plus everything the sequence scan needs to know about it. */
interface Atom {
  readonly set: FirstChars
  /** Whether the atom consumes input at all: anchors and lookarounds do not,
   *  and so cannot separate two repetitions. */
  readonly consumes: boolean
  /** A group's own body, so a quantifier applied to the group can be checked
   *  against what it holds. */
  readonly group?: Frame
  /** Whether the atom can consume a variable number of units BY ITSELF — a
   *  group holding a repetition, with no quantifier of its own. */
  readonly variable: boolean
}

/** The last variable-length atom of one sequence, plus the mandatory atoms
 *  seen since it (see {@link note}). */
interface Pending {
  readonly set: FirstChars
  /** Mandatory consuming atoms since the repetition. */
  barrier: number
  /** Whether one of those atoms overlaps the repetition's own set — i.e. the
   *  repetition can swallow the separator rather than being pinned by it. */
  crossed: boolean
}

/** One open group (or the whole pattern). */
interface Frame {
  readonly lookaround: boolean
  /** An alternation inside this group — the "quantified alternation" shape. */
  alternation: boolean
  /** A quantifier applied to anything inside this group. */
  hasQuantifier: boolean
  /** A variable-length atom inside this group. */
  hasVariable: boolean
  /** The current alternative's first consuming atom (null = none yet). */
  first: FirstChars | null
  /** The alternatives closed so far. */
  readonly firsts: (FirstChars | null)[]
  /** The sequence scan's state for the current alternative. */
  pending: Pending | undefined
}

function newFrame(lookaround: boolean): Frame {
  return {
    lookaround,
    alternation: false,
    hasQuantifier: false,
    hasVariable: false,
    first: null,
    firsts: [],
    pending: undefined,
  }
}

/** A variable-length repetition: unbounded, or spanning at least three
 *  lengths. `?` (two lengths) is deliberately NOT one — a lone optional atom
 *  is not a backtracking family, and treating it as one would refuse ordinary
 *  patterns (`\d?\d?\d?`). */
function isStretchy(rep: Repetition): boolean {
  return rep.max === Number.POSITIVE_INFINITY || rep.max - rep.min >= 2
}

/** Read the repetition suffix at `at`, if any. A `{` that does not open a
 *  well-formed `{n}`, `{n,}` or `{n,m}` is a literal brace (Annex B), and the
 *  engine will treat it as one. */
function readRepetition(source: string, at: number): Repetition | undefined {
  const unit = source[at]
  if (unit === '*' || unit === '+' || unit === '?') {
    let next = at + 1
    if (source[next] === '?') next += 1 // lazy
    return {
      min: unit === '+' ? 1 : 0,
      max: unit === '?' ? 1 : Number.POSITIVE_INFINITY,
      brace: false,
      next,
    }
  }
  if (unit !== '{') return undefined
  const match = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(at, at + 16))
  if (match === null) return undefined
  const min = Number(match[1])
  const max = match[2] === undefined ? min : match[2] === '' ? Number.POSITIVE_INFINITY : Number(match[2])
  let next = at + match[0].length
  if (source[next] === '?') next += 1 // lazy
  return { min, max, brace: true, next }
}

/** Fold one parsed atom into its frame, returning false for an unsafe shape.
 *  This is where every verdict is decided; see the module doc for the pair
 *  rule and the quantified-group rules it preserves. */
function note(frame: Frame, atom: Atom, rep: Repetition | undefined): boolean {
  if (rep !== undefined) {
    frame.hasQuantifier = true
    if (atom.group !== undefined) {
      // A brace-quantified group is refused outright (the legacy `){` rule),
      // and so is a quantified group holding a quantifier or an alternation:
      // those are the classic `(a+)+` / `(a|b)+` / `(a?)+` families, where the
      // repetition multiplies itself.
      if (rep.brace) return false
      if (atom.group.hasQuantifier || atom.group.alternation) return false
    }
  }
  const variable = atom.variable || (rep !== undefined && isStretchy(rep))
  if (variable) frame.hasVariable = true

  if (atom.consumes) {
    const pending = frame.pending
    if (variable && pending !== undefined) {
      // The earlier repetition reaches into this one when nothing mandatory
      // separates them, or when what separates them is itself matchable by the
      // earlier one — and their first characters must be able to coincide.
      if ((pending.barrier === 0 || pending.crossed) && overlaps(pending.set, atom.set)) return false
    }
    if (variable) {
      frame.pending = { set: atom.set, barrier: 0, crossed: false }
    } else if (pending !== undefined) {
      pending.barrier += 1
      if (overlaps(pending.set, atom.set)) pending.crossed = true
    }
    if (frame.first === null) frame.first = atom.set
  }
  return true
}

/** Parse the escape at `at` (the backslash). Returns the atom and where the
 *  next atom starts, `'unsafe'` for a backreference, or undefined for an
 *  escape that is not an atom at all (a trailing backslash — the engine
 *  rejects the pattern). */
function parseEscape(source: string, at: number): { atom: Atom; next: number } | 'unsafe' | undefined {
  const code = source[at + 1]
  if (code === undefined) return undefined
  const literal = (set: FirstChars, next: number): { atom: Atom; next: number } => ({
    atom: { set, consumes: true, variable: false },
    next,
  })
  if (code >= '1' && code <= '9') return 'unsafe' // backreference
  if (code === 'k' && source[at + 2] === '<') return 'unsafe' // named backreference
  if (code === 'b' || code === 'B') {
    return { atom: { set: EMPTY, consumes: false, variable: false }, next: at + 2 }
  }
  const simple = escapeSet(code)
  // A complemented class (`\D`, `\W`, `\S`) intersects almost anything; the
  // conservative reading is "matches anything" (see {@link FirstChars}).
  if (simple === 'unknown') return literal(undefined, at + 2)
  if (simple !== undefined) return literal(simple, at + 2)
  if (code === 'x') {
    const hex = /^[0-9a-fA-F]{2}/.exec(source.slice(at + 2, at + 4))
    if (hex !== null) return literal(new Set([Number.parseInt(hex[0], 16)]), at + 4)
    return literal(units('x'), at + 2) // Annex B: an incomplete \x is a literal x
  }
  if (code === 'u') {
    const hex = /^[0-9a-fA-F]{4}/.exec(source.slice(at + 2, at + 6))
    if (hex !== null) return literal(units(String.fromCharCode(Number.parseInt(hex[0], 16))), at + 6)
    return literal(units('u'), at + 2)
  }
  if (code === 'c') {
    // Control escape: an unknown one is a literal backslash + c (Annex B).
    const letter = source[at + 2]
    if (letter !== undefined && /[A-Za-z]/.test(letter)) {
      return literal(new Set([letter.toUpperCase().charCodeAt(0) - 64]), at + 3)
    }
    return literal(units('c'), at + 2)
  }
  // An identity escape (`\q`, `\@`, …) and an escaped metacharacter: the code
  // unit itself.
  return literal(units(code), at + 2)
}

/** The set of a single-letter class escape, or undefined when it is not one. */
function escapeSet(code: string): FirstChars | 'unknown' | undefined {
  switch (code) {
    case 'd':
      return DIGITS
    case 'w':
      return WORD
    case 's':
      return SPACES
    // The complements intersect almost everything; "matches anything" is the
    // conservative reading and keeps the pair rule simple.
    case 'D':
    case 'W':
    case 'S':
      return 'unknown'
    case 'n':
      return new Set([10])
    case 'r':
      return new Set([13])
    case 't':
      return new Set([9])
    case 'f':
      return new Set([12])
    case 'v':
      return new Set([11])
    case '0':
      return new Set([0])
    default:
      return undefined
  }
}

/** Parse a `[...]` class starting at `at` (which points at `[`). */
function parseClass(source: string, at: number): { atom: Atom; next: number } {
  let index = at + 1
  let negated = false
  if (source[index] === '^') {
    negated = true
    index += 1
  }
  let set: Set<number> = new Set()
  let anything = negated
  let closed = false
  while (index < source.length) {
    const unit = source[index]!
    if (unit === ']') {
      closed = true
      index += 1
      break
    }
    let low: number | undefined
    let width = 1
    if (unit === '\\') {
      const code = source[index + 1]
      if (code === undefined) break
      const escaped = escapeSet(code)
      if (escaped === 'unknown') anything = true
      else if (escaped !== undefined) {
        if (escaped.size > 1) {
          for (const value of escaped) set.add(value)
        } else {
          low = [...escaped][0]
        }
      } else if (code === 'b') {
        low = 8 // backspace inside a class
      } else {
        low = code.charCodeAt(0)
      }
      index += 2
      if (code === 'x' || code === 'u') {
        const length = code === 'x' ? 2 : 4
        const hex = new RegExp(`^[0-9a-fA-F]{${length}}`).exec(source.slice(index, index + length))
        if (hex !== null) {
          low = Number.parseInt(hex[0], 16)
          index += length
        }
      }
    } else {
      low = source.codePointAt(index)!
      width = low > 0xffff ? 2 : 1
      index += width
    }
    // A range: `low-high`, where the high end is a single unit.
    if (source[index] === '-' && source[index + 1] !== undefined && source[index + 1] !== ']') {
      const highUnit = source[index + 1]!
      let high: number
      if (highUnit === '\\') {
        const code = source[index + 2]
        const escaped = code === undefined ? undefined : escapeSet(code)
        if (escaped === 'unknown' || escaped === undefined || escaped.size !== 1) {
          anything = true
          index += 2
          continue
        }
        high = [...escaped][0]!
        index += 3
      } else {
        high = highUnit.charCodeAt(0)
        index += 2
      }
      if (low !== undefined && high >= low && high - low <= RANGE_EXPAND_LIMIT) {
        for (let value = low; value <= high; value++) set.add(value)
      } else {
        anything = true
      }
      continue
    }
    if (low !== undefined) {
      const point = low
      set.add(point)
      // A non-BMP code point is two units; both may start a match.
      if (point > 0xffff) {
        const text = String.fromCodePoint(point)
        set.add(text.charCodeAt(0))
        set.add(text.charCodeAt(1))
      }
    }
  }
  // An unclosed class is a syntax error the engine reports; the empty-class
  // verdict below is irrelevant there.
  const verdict = anything || !closed ? undefined : set
  return { atom: { set: verdict, consumes: true, variable: false }, next: index }
}

/** Parse one simple atom (everything but a group opener) at `at`. */
function parseSimple(source: string, at: number): { atom: Atom; next: number } | 'unsafe' | undefined {
  const unit = source[at]!
  if (unit === '\\') {
    const parsed = parseEscape(source, at)
    if (parsed === 'unsafe') return 'unsafe'
    if (parsed === undefined) return undefined
    return parsed
  }
  if (unit === '[') return parseClass(source, at)
  if (unit === '.') return { atom: { set: undefined, consumes: true, variable: false }, next: at + 1 }
  if (unit === '^' || unit === '$') {
    return { atom: { set: EMPTY, consumes: false, variable: false }, next: at + 1 }
  }
  const point = source.codePointAt(at)!
  const set = new Set<number>([point])
  const width = point > 0xffff ? 2 : 1
  if (width === 2) {
    const text = String.fromCodePoint(point)
    set.add(text.charCodeAt(0))
    set.add(text.charCodeAt(1))
  }
  return { atom: { set, consumes: true, variable: false }, next: at + width }
}

/** Read a group's `?…` prefix; returns where its body starts. */
function skipGroupPrefix(source: string, at: number): { next: number; lookaround: boolean } | 'unsafe' {
  if (source[at] !== '?') return { next: at, lookaround: false }
  const code = source[at + 1]
  if (code === ':') return { next: at + 2, lookaround: false }
  if (code === '=' || code === '!') return { next: at + 2, lookaround: true }
  if (code === '<') {
    const third = source[at + 2]
    if (third === '=' || third === '!') return { next: at + 3, lookaround: true }
    const close = source.indexOf('>', at + 2)
    if (close !== -1) return { next: close + 1, lookaround: false } // named capture
    return 'unsafe' // a malformed named group: refuse rather than guess
  }
  // `(?…` the plugin does not model (a future flag syntax, say): the group is
  // still scanned as an ordinary one, and an unparseable pattern is refused
  // by the engine afterwards.
  return { next: at + 1, lookaround: false }
}

/** Union of the closed frame's alternative first-sets. */
function frameFirsts(frame: Frame): FirstChars {
  let seen = false
  let union: Set<number> | undefined
  for (const first of [...frame.firsts, frame.first]) {
    if (first === null) continue
    if (first === undefined) return undefined
    seen = true
    union ??= new Set<number>()
    for (const unit of first) union.add(unit)
  }
  return seen ? union : EMPTY
}

/** Whether `source` holds a shape the plugin refuses to run. */
export function regexGuardVerdict(source: string): RegexGuardVerdict {
  return scanPattern(source) ? 'unsafe' : 'ok'
}

/** The scan itself: true when an unsafe shape was found. */
function scanPattern(source: string): boolean {
  const stack: Frame[] = []
  let frame = newFrame(false)
  let at = 0

  while (at < source.length) {
    const unit = source[at]!
    if (unit === '|') {
      frame.alternation = true
      frame.firsts.push(frame.first)
      frame.first = null
      frame.pending = undefined
      at += 1
      continue
    }

    let atom: Atom
    if (unit === ')') {
      at += 1
      if (stack.length === 0) continue // unbalanced: the engine rejects it
      const closed = frame
      frame = stack.pop()!
      atom = {
        set: frameFirsts(closed),
        consumes: !closed.lookaround,
        group: closed,
        variable: closed.hasVariable,
      }
    } else if (unit === '(') {
      const prefix = skipGroupPrefix(source, at + 1)
      if (prefix === 'unsafe') return true
      stack.push(frame)
      frame = newFrame(prefix.lookaround)
      at = prefix.next
      continue
    } else {
      const simple = parseSimple(source, at)
      if (simple === 'unsafe') return true
      if (simple === undefined) {
        // A trailing backslash: nothing to model, and the engine refuses it.
        break
      }
      atom = simple.atom
      at = simple.next
    }

    const rep = readRepetition(source, at)
    if (!note(frame, atom, rep)) return true
    if (rep !== undefined) at = rep.next
  }
  return false
}
