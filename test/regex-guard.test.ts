/**
 * Tests for the structural regex cost screen (REVIEW R-099): the shapes that
 * freeze the host TUI must be refused, and the ordinary search patterns must
 * keep compiling.
 */
import { describe, expect, it } from 'vitest'
import { regexGuardVerdict } from '../src/core/regex-guard.js'
import { compileRegex, isRegexAllowed, MAX_REGEX_PATTERN_LENGTH, regexRejection } from '../src/core/search.js'

/** Patterns that must stay usable: every one of them is matched by an
 *  ordinary query, and every one of them was measured (or reasoned) to be
 *  free of the overlapping-repetition family. */
const ALLOWED = [
  'auth',
  're\\w*ry|jitter',
  'ab{2,3}',
  '\\(x\\)\\{2,\\}',
  '\\d+\\.\\d+',
  '^session\\s+title$',
  '(foo|bar)baz',
  '\\w+@\\w+\\.\\w+',
  'a*b*c*',
  '(\\d+)-(\\d+)',
  '\\d?\\d?\\d?',
  '.*z',
  'foo.*bar',
  '[a-z]+@example\\.com',
  '\\bneedle\\b',
]

/** Patterns whose backtracking is catastrophic (or that repeat a group's own
 *  ambiguity): the screen must refuse them. The first three were measured in
 *  the review — `.*.*.*z` does not finish within 3 s on 500 characters, and
 *  `a*a*a*a*a*a*a*a*b` does not finish within 5 minutes on 100 characters. */
const REFUSED = [
  '.*.*z',
  '.*.*.*z',
  'a*a*a*a*a*a*a*a*b',
  '.*a.*b',
  '.*foo.*bar',
  '\\w+\\w+',
  '[a-z]+[a-m]+',
  '(\\d+)(\\d+)',
  '(a+)+$',
  '(a|b)+',
  '(a+){2,}',
  '(a?)+',
  '(?:(?:a)*)*',
  '((a)+)+',
  'a+\\1',
  '\\k<name>',
  '(?<name>a+)\\k<name>',
]

describe('regexGuardVerdict', () => {
  it('keeps ordinary search patterns compilable', () => {
    for (const pattern of ALLOWED) {
      expect(regexGuardVerdict(pattern), pattern).toBe('ok')
      expect(compileRegex(pattern, false), pattern).toBeInstanceOf(RegExp)
    }
  })

  it('refuses the overlapping-repetition and nested-repetition families', () => {
    for (const pattern of REFUSED) {
      expect(regexGuardVerdict(pattern), pattern).toBe('unsafe')
      expect(isRegexAllowed(pattern), pattern).toBe(false)
      expect(compileRegex(pattern, false), pattern).toBeUndefined()
    }
  })

  it('never throws on malformed or truncated input', () => {
    // The engine is the syntax authority; the screen only has to stay alive
    // and return a verdict while the user is still typing.
    for (const pattern of ['', '(', ')', '[', '\\', 'a{', '*', '(?<', '(?<x', '{2,3}', '\\u12', '[]', '[^]', '\\c']) {
      expect(typeof regexGuardVerdict(pattern), pattern).toBe('string')
    }
  })

  it('keeps the length cap in front of the structural screen', () => {
    expect(isRegexAllowed('a'.repeat(MAX_REGEX_PATTERN_LENGTH))).toBe(true)
    expect(isRegexAllowed('a'.repeat(MAX_REGEX_PATTERN_LENGTH + 1))).toBe(false)
  })
})

describe('regexRejection', () => {
  it('names a refused-but-valid pattern differently from a syntax error', () => {
    expect(regexRejection('.*.*z', false)).toBe('unsafe')
    expect(regexRejection('a(', false)).toBe('syntax')
    expect(regexRejection('auth', false)).toBeUndefined()
  })
})
