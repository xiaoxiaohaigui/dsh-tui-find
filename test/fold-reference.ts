/**
 * A frozen copy of the PRE-refactor fold construction (`src/core/search.ts`
 * at `bac6313`, phase 1a of the perf plan), kept only as the equivalence
 * oracle for `fold-equivalence.test.ts`.
 *
 * Why a copy and not the live code: the two implementations must be diffable
 * field by field (folded string, `cumUnits`, `cpStart`, `segmentStarts`),
 * because a fold that is merely "close" still scans and still highlights —
 * just one character off, which no behavioral test reliably catches. This
 * file is deliberately NOT imported by `src/`: it is expected to look dated,
 * to use `[...text]` and per-code-point string concatenation, and to be
 * deleted together with the test if the fold representation itself ever
 * changes. Until then, it is the only honest way to prove the fast path
 * computes the same tables as the slow one.
 *
 * Mirrors `FoldedText` / `PinyinFolds` structurally so the test can compare
 * the two without widening the source module's type surface.
 */
import { PINYIN_READINGS } from '../src/core/pinyin-data.js'

export interface RefFoldedText {
  readonly folded: string
  readonly cumUnits: Uint32Array
  readonly cpStart: Uint32Array
  readonly sourceLength: number
  readonly segmentStarts?: Uint8Array
}

export interface RefPinyinFolds {
  readonly allReadings: RefFoldedText
  readonly firstReading: RefFoldedText
  readonly allInitials: RefFoldedText
  readonly firstInitials: RefFoldedText
}

/** The pre-refactor `buildFold`, verbatim in behavior. */
export function refBuildFold(text: string): RefFoldedText {
  const characters = [...text]
  const cpStart = new Uint32Array(characters.length + 1)
  const cumUnits = new Uint32Array(characters.length + 1)
  let folded = ''
  let utf16 = 0
  let units = 0
  for (let index = 0; index < characters.length; index++) {
    const char = characters[index]!
    cpStart[index] = utf16
    utf16 += char.length
    const lower = char.toLowerCase()
    folded += lower
    units += lower.length
    cumUnits[index + 1] = units
  }
  cpStart[characters.length] = utf16
  return { folded, cumUnits, cpStart, sourceLength: text.length }
}

/** The pre-refactor `buildPinyinFolds`, verbatim in behavior. */
export function refBuildPinyinFolds(text: string, caseSensitive: boolean): RefPinyinFolds | undefined {
  const characters = [...text]
  const cpStart = new Uint32Array(characters.length + 1)
  let utf16 = 0
  let hasTable = false
  for (let index = 0; index < characters.length; index++) {
    const char = characters[index]!
    cpStart[index] = utf16
    utf16 += char.length
    if (PINYIN_READINGS[char] !== undefined) hasTable = true
  }
  cpStart[characters.length] = utf16
  if (!hasTable) return undefined

  const allCum = new Uint32Array(characters.length + 1)
  const firstCum = new Uint32Array(characters.length + 1)
  const allInitCum = new Uint32Array(characters.length + 1)
  const firstInitCum = new Uint32Array(characters.length + 1)
  let all = ''
  let first = ''
  let allInit = ''
  let firstInit = ''
  let allUnits = 0
  let firstUnits = 0
  let allInitUnits = 0
  let firstInitUnits = 0
  const allStarts: number[] = []
  const firstStarts: number[] = []
  const markSegment = (starts: number[], start: number): void => {
    starts[start] = 1
  }
  for (let index = 0; index < characters.length; index++) {
    const char = characters[index]!
    const readings = PINYIN_READINGS[char]
    if (readings === undefined) {
      const literal = caseSensitive ? char.toUpperCase() : char.toLowerCase()
      all += literal
      first += literal
      allInit += literal
      firstInit += literal
      const units = literal.length
      markSegment(allStarts, allUnits)
      markSegment(firstStarts, firstUnits)
      allUnits += units
      firstUnits += units
      allInitUnits += units
      firstInitUnits += units
    } else {
      let readingStart = allUnits
      let readingAt = 0
      for (;;) {
        const next = readings.indexOf(' ', readingAt)
        const reading = next === -1 ? readings.slice(readingAt) : readings.slice(readingAt, next)
        all += reading
        allUnits += reading.length
        markSegment(allStarts, readingStart)
        if (next === -1) break
        all += ' '
        allUnits += 1
        readingStart = allUnits
        readingAt = next + 1
      }
      const space = readings.indexOf(' ')
      const firstReading = space === -1 ? readings : readings.slice(0, space)
      first += firstReading
      firstUnits += firstReading.length
      markSegment(firstStarts, firstUnits - firstReading.length)
      firstInit += firstReading[0]!
      firstInitUnits += 1
      let from = 0
      for (;;) {
        allInit += readings[from]!
        allInitUnits += 1
        const next = readings.indexOf(' ', from)
        if (next === -1) break
        from = next + 1
      }
    }
    allCum[index + 1] = allUnits
    firstCum[index + 1] = firstUnits
    allInitCum[index + 1] = allInitUnits
    firstInitCum[index + 1] = firstInitUnits
  }
  const segments = (starts: number[], length: number) => ({
    segmentStarts: Uint8Array.from({ length: length + 1 }, (_, at) => starts[at] === 1 ? 1 : 0),
  })
  const allSegments = segments(allStarts, allUnits)
  const firstSegments = segments(firstStarts, firstUnits)
  return {
    allReadings: { folded: all, cumUnits: allCum, cpStart, sourceLength: text.length, ...allSegments },
    firstReading: { folded: first, cumUnits: firstCum, cpStart, sourceLength: text.length, ...firstSegments },
    allInitials: { folded: allInit, cumUnits: allInitCum, cpStart, sourceLength: text.length },
    firstInitials: { folded: firstInit, cumUnits: firstInitCum, cpStart, sourceLength: text.length },
  }
}
