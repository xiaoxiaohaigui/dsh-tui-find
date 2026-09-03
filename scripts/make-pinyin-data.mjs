/**
 * Regenerate `src/core/pinyin-data.ts` — the common-character pinyin table
 * the search core folds Chinese text with.
 *
 * Sources (both referenced from the generated file's header as well):
 * - Char list: `scripts/common-chars-1988.txt` — 《现代汉语常用字表》
 *   (1988, 3500 chars), fetched from zispace/hanzi-chars 0.1.2; the file
 *   keeps its own provenance header. Comment lines (`#`) and blank lines
 *   are skipped, the first character of every other line is taken.
 * - Readings: pinyin-pro 3.x (MIT) — ALL toneless readings per char
 *   (polyphones included) in the dictionary's frequency order, with
 *   `v: true` so ü surfaces as the keyboard form ("lv", "nv").
 *
 * pinyin-pro is a dev-time-only tool — the plugin itself keeps zero
 * runtime dependencies. Regenerate with:
 *
 *     npm i --no-save pinyin-pro && node scripts/make-pinyin-data.mjs
 *
 * The output is deterministic (entries sorted by code point), so a rerun
 * with the same inputs produces a byte-identical file.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { pinyin } = require('pinyin-pro')

const here = dirname(fileURLToPath(import.meta.url))
const charsFile = join(here, 'common-chars-1988.txt')
const outFile = join(here, '..', 'src', 'core', 'pinyin-data.ts')

const raw = readFileSync(charsFile, 'utf8')
const chars = []
for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) continue
  chars.push([...trimmed][0])
}
const unique = [...new Set(chars)].sort((a, b) => a.codePointAt(0) - b.codePointAt(0))

const entries = []
const missing = []
for (const char of unique) {
  const readings = pinyin(char, { multiple: true, toneType: 'none', type: 'array', v: true })
  const valid = [...new Set(readings)].filter(reading => /^[a-z]+$/.test(reading))
  if (valid.length === 0) {
    missing.push(char)
    continue
  }
  entries.push([char, valid.join(' ')])
}

if (entries.length === 0) throw new Error('no readings resolved — is pinyin-pro installed?')

const lines = entries.map(([char, readings]) => `  '${char}': '${readings}',`)
const header = `/**
 * Common-character pinyin table: char → space-separated toneless readings
 * (polyphones carry every reading, frequency-ordered first; ü is written
 * as the keyboard form "v" — "lv", "nv").
 *
 * GENERATED FILE — do not edit by hand. Regenerate with:
 *     npm i --no-save pinyin-pro && node scripts/make-pinyin-data.mjs
 *
 * - Chars: 《现代汉语常用字表》 (1988, ${entries.length} entries here) via
 *   scripts/common-chars-1988.txt, fetched from zispace/hanzi-chars 0.1.2.
 * - Readings: pinyin-pro 3.x (MIT), all readings per char.
 *
 * The table covers the common-character set only: rarer characters fold to
 * themselves (no pinyin matching), which the search core treats as absent
 * data, never as an error. {@module dsh-tui-find/core/pinyin-data}
 */
`

const body = `${header}export const PINYIN_READINGS: Readonly<Record<string, string>> = {
${lines.join('\n')}
}
`

writeFileSync(outFile, body, 'utf8')
console.log(`wrote ${outFile}: ${entries.length} entries, ${body.length} bytes`)
if (missing.length > 0) {
  console.log(`chars without readings (${missing.length}): ${missing.join('')}`)
}
