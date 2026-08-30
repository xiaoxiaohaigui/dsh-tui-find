/**
 * The read-only session scanner: enumerate every stored dsh session under
 * the resolved roots, decode each log tolerantly into an in-memory index,
 * and keep that index warm behind a per-file `bytes:mtime` cache so a warm
 * search costs zero log reads.
 *
 * Discipline, inherited from the host's own reader:
 *
 * - READ-ONLY: files are opened 'r' and never written; the history lock is
 *   never touched (the store is shared with dsh web and possibly a second
 *   TUI instance — #588/#593 taught what a lock competitor costs).
 * - TOLERANT: a torn final frame (crash mid-flush) is dropped as
 *   uncommitted; an undecodable frame or line costs that frame, never the
 *   scan; an unreadable log degrades to a headerless entry rather than
 *   aborting the sweep.
 * - BOUNDED: one log in memory at a time; every frame decode budget-checked
 *   (`MAX_DECODED_FRAME_BYTES`); the event loop is yielded between files
 *   (and inside very large ones) so the UI stays live during a cold first
 *   sweep; an AbortSignal stops the sweep between frames.
 *
 * Cache semantics mirror the host's session index: the token is
 * `bytes:mtimeMs`, which for an append-only log is an honest change token —
 * append growth changes both, and a same-size touch (rename) maps to a new
 * path-level identity the next sweep re-derives anyway.
 *
 * v0.2 offset watermark: each cache entry records `decodedTo`, the byte
 * offset just past the last complete frame (or newline-terminated plain
 * line) its extract state has folded, and keeps that state alive — so when
 * a log GROWS, the next sweep re-walks the frame chain (structural, no
 * decode), verifies a frame still ends exactly at the watermark, verifies
 * a sampled digest of the bytes before it (first/last 4 KB — the boundary
 * proof alone cannot see a same-boundary equal-length rewrite), and decodes
 * only the frames beyond it, continuing the fold. A same-size mtime touch
 * verifies the same way and decodes nothing. Any mismatch (shrunk file,
 * moved boundary, rewritten prefix, encoding flip, options change) falls
 * back to a full decode.
 *
 * The watermark also survives process restarts as a durable journal — a
 * small offsets-only file (no conversation text ever leaves memory) written
 * atomically with the host store's privacy posture: 0700 directory, 0600
 * file, tmp+rename. The journal is a record and an assertion surface, not a
 * data source: a cold process must still decode every prefix, because the
 * in-memory index is the only place the decoded text lives.
 *
 * @module dsh-tui-find/core/scan
 */
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decodeFrame, sniffEncoding, walkFrames, type LogLine } from './frames.js'
import {
  DEFAULT_EXTRACT_OPTIONS,
  extractLine,
  newExtractState,
  type ExtractOptions,
  type ExtractState,
  type SessionContent,
} from './events.js'
import { sessionsRoots } from './roots.js'

/** One scanned session's searchable content. */
export interface ScannedSession extends SessionContent {
  readonly id: string
  /** Absolute log path (the .zstd twin when both encodings exist). */
  readonly path: string
  readonly bytes: number
  readonly modifiedAt: number
}

/** Options for one sweep. */
export interface ScanOptions extends Partial<ExtractOptions> {
  /** Manual session-root override (settings field), prepended to the chain. */
  readonly sessionRoot?: string | undefined
  /** Cancellation for the sweep. */
  readonly signal?: AbortSignal | undefined
  /** Progress callback, invoked between files. */
  readonly onProgress?: ((progress: ScanProgress) => void) | undefined
}

export interface ScanProgress {
  /** Sessions resolved so far (cache hits included once verified). */
  readonly resolved: number
  /** Sessions known to exist when enumeration finished; undefined before. */
  readonly total: number | undefined
  /** Log bytes decoded so far in this sweep (cache hits count nothing;
   *  watermark resumes count only the newly decoded range). */
  readonly decodedBytes: number
  /** Sessions whose decode resumed from a watermark this sweep — the
   *  assertion surface for "only the new frames were decoded". */
  readonly resumed: number
}

/** Physical facts of one log file, read once per sweep. */
interface LogFacts {
  readonly path: string
  readonly bytes: number
  readonly mtimeMs: number
}

interface CacheEntry {
  readonly bytes: number
  readonly mtimeMs: number
  /** Signature of the extraction options the content was built with — a
   *  switch flip (indexTools/indexThinking/char cap) must invalidate. */
  readonly optionsKey: string
  /**
   * Byte offset just past the last complete frame (zstd) or newline-
   * terminated line (plain) that {@link state} has folded — the resume
   * watermark. Always ≤ `bytes`; the gap (when any) is an undecodable torn
   * tail, and both values move together on every commit, so a token match
   * implies the snapshot covers everything decodable in that file version.
   */
  readonly decodedTo: number
  /**
   * Digest of the sampled bytes before {@link decodedTo} (first/last 4 KB,
   * whole prefix when smaller) — the second half of the append-only prefix
   * proof: the boundary check proves the watermark is still a frame/line
   * boundary, this proves the bytes before it are still the ones the cached
   * fold was built from, closing the same-boundary equal-length rewrite
   * hole. In-memory only; the journal stays offsets-only (it never takes
   * part in resume decisions).
   */
  readonly prefixDigest: string
  /** Encoding the watermark was taken under; an encoding flip is a rewrite
   *  and forces a full decode. */
  readonly isZstd: boolean
  /** The live extract fold, continuable on the next append. */
  readonly state: ExtractState
  /** Frozen snapshot served to searches (stable message identities). */
  readonly session: ScannedSession
}

/** What {@link SessionScanner.decodeLog} hands back: the cache-ready
 *  snapshot plus the watermark facts the entry is committed with. */
interface DecodedLog {
  readonly session: ScannedSession
  readonly state: ExtractState
  readonly decodedTo: number
  readonly prefixDigest: string
  readonly isZstd: boolean
}

/** Upper bound on a single log we will read whole; beyond it the session is
 * skipped entirely — no index entry, so it neither searches nor lists. (A
 * 128 MB conversation log is far outside anything the format produces in
 * practice; the cap is a seatbelt against pathological files.) */
const MAX_LOG_BYTES = 128 * 1024 * 1024

/** Plain-JSONL decode yields to the event loop every this many lines — the
 *  zstd path yields per frame batch, but the plain path has no frame
 *  boundaries, and without a yield a near-`MAX_LOG_BYTES` log would block
 *  the loop (and with it the abort check and the UI) for seconds. */
const PLAIN_YIELD_EVERY_LINES = 2048

/**
 * Session ids reach `path.join()`; a safe single segment (UUID or
 * `session-<uuid>`-shaped) is enforced exactly like the host's compat layer.
 */
function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)
}

/**
 * Stat one candidate log into {@link LogFacts}; undefined when it does not
 * exist or is not a regular file (a vanished or odd entry simply is not
 * listed). Stat-only, with no `existsSync` pre-check: enumeration runs
 * synchronously before the sweep's first yield, so every session costs at
 * most one syscall per candidate encoding.
 */
function statFile(path: string): LogFacts | undefined {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return undefined
    return { path, bytes: stats.size, mtimeMs: stats.mtimeMs }
  } catch {
    return undefined
  }
}

/** Enumerate every session log under the roots; first hit wins per id. */
export function enumerateLogs(sessionRoot?: string): Map<string, LogFacts> {
  const found = new Map<string, LogFacts>()
  for (const root of sessionsRoots(sessionRoot)) {
    let workspaces: string[]
    try {
      workspaces = readdirSync(root)
    } catch {
      continue
    }
    for (const ws of workspaces) {
      // Session ids reach path.join() through a strict whitelist; the
      // workspace segment gets the same hazard treatment — a `..` entry
      // must not walk the enumeration out of the root. (readdirSync never
      // returns names with separators, so dot entries are the only risk.)
      if (ws === '.' || ws === '..') continue
      let ids: string[]
      try {
        ids = readdirSync(join(root, ws))
      } catch {
        continue
      }
      for (const id of ids) {
        if (found.has(id) || !isSafeSessionId(id)) continue
        const dir = join(root, ws, id)
        // Compressed wins when both encodings exist (host's own preference);
        // a compressed side that is not a regular file does not shadow the
        // plain twin beside it.
        const facts =
          statFile(join(dir, 'session.jsonl.zstd')) ?? statFile(join(dir, 'session.jsonl'))
        if (facts === undefined) continue
        found.set(id, facts)
      }
    }
  }
  return found
}

/**
 * Read a whole file's bytes with a shared open; undefined when unreadable.
 * (Single open per file — the scanner never keeps handles across yields.)
 */
function readWholeFile(path: string): Buffer | undefined {
  let handle: number
  try {
    handle = openSync(path, 'r')
  } catch {
    return undefined
  }
  try {
    return readFileSync(handle)
  } catch {
    return undefined
  } finally {
    try {
      closeSync(handle)
    } catch {
      // The read already ended; a close failure leaves nothing actionable.
    }
  }
}

/**
 * Plain-JSONL line reader over a whole-file buffer, byte-split (no
 * per-line string copying): UTF-8 multi-byte sequences never contain the
 * 0x0A byte, so byte-level splitting is encoding-safe. Each yielded line
 * carries the offset just past its newline — the plain path's watermark —
 * and an unterminated final line is a torn write: dropped, not parsed,
 * matching the host's own reader. Lines that parse to nothing usable
 * (empty, malformed, non-object) yield with `line: undefined` so the
 * caller's watermark still advances past them.
 */
function* plainLines(buffer: Buffer, from = 0): Generator<{ line: LogLine | undefined; end: number }> {
  let start = from
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start)
    if (newline === -1) return // torn tail — uncommitted, dropped
    const end = newline + 1
    let line: LogLine | undefined
    if (newline > start) {
      try {
        const parsed: unknown = JSON.parse(buffer.toString('utf8', start, newline))
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          line = parsed as LogLine
        }
      } catch {
        // One malformed line costs itself only.
      }
    }
    yield { line, end }
    start = end
  }
}

/** Sample size for {@link prefixDigest}: the first and last this many bytes
 *  before the watermark (the whole prefix when it is smaller). An append
 *  leaves both windows byte-identical; an equal-length rewrite of the
 *  decoded prefix moves bytes in at least one of them with overwhelming
 *  likelihood, at O(kilobytes) per resume check regardless of log size. */
const PREFIX_SAMPLE_BYTES = 4096

/**
 * Digest of the sampled bytes before offset `end` of `buffer` — the resume
 * path recomputes this over the live buffer and compares against the value
 * committed with the cache entry. Sampled rather than whole-prefix so the
 * check stays cheap on 100 MB logs; deterministic, so equal inputs always
 * compare equal and an untouched prefix never forces a full decode.
 */
function prefixDigest(buffer: Buffer, end: number): string {
  const hash = createHash('sha256')
  if (end <= PREFIX_SAMPLE_BYTES) {
    hash.update(buffer.subarray(0, end))
  } else {
    hash.update(buffer.subarray(0, PREFIX_SAMPLE_BYTES))
    hash.update(buffer.subarray(end - PREFIX_SAMPLE_BYTES, end))
  }
  return hash.digest('hex')
}

/** Yield to the event loop so a cold sweep never blocks the render tick. */
function yieldToLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** The extract fold cloned before an incremental resume folds into it: an
 *  aborted resume must leave the cached state untouched, and the clone's
 *  copied references keep every old message object (and its search-side
 *  fold cache entry) alive. */
function cloneState(state: ExtractState): ExtractState {
  return { title: state.title, header: { ...state.header }, messages: [...state.messages] }
}

/** One log's durable watermark: the offset past the last decodable unit at
 *  the moment of its last decode, plus the file facts it was taken under.
 *  Offsets and stats only — conversation text never leaves memory. */
interface WatermarkFacts {
  readonly bytes: number
  readonly mtimeMs: number
  readonly offset: number
  readonly optionsKey: string
  readonly at: number
}

/** path → watermark, as loaded from and mirrored to the journal file. */
type WatermarkJournal = Record<string, WatermarkFacts>

/** Entries the journal keeps before the oldest (by `at`) are dropped: a
 *  watermark is ~150 bytes of JSON, so this bounds the file well under half
 *  a megabyte even for giant libraries. */
const JOURNAL_MAX_ENTRIES = 1024

/**
 * The scanner. One instance per plugin activation; the index lives for the
 * process lifetime in memory only (the spec's privacy posture keeps
 * conversation text out of new files). When constructed with a
 * `watermarkPath`, each sweep also mirrors the per-log offset watermarks
 * into that one journal file (atomic, 0600/0700) so the record survives
 * restarts — the resume itself still requires the in-memory state, so a
 * cold process decodes every prefix exactly once.
 */
export class SessionScanner {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly watermarkPath: string | undefined
  private journal: WatermarkJournal | undefined
  private journalSaved: string | undefined

  constructor(options: { watermarkPath?: string | undefined } = {}) {
    this.watermarkPath = options.watermarkPath
  }

  /** The journal, loaded once and tolerated missing/corrupt (it is a
   *  record, not a data source — any failure just means an empty start). */
  private loadJournal(): WatermarkJournal {
    if (this.watermarkPath === undefined) return {}
    if (this.journal !== undefined) return this.journal
    const loaded: WatermarkJournal = {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.watermarkPath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entries = (parsed as { entries?: unknown })['entries']
        if (entries !== null && typeof entries === 'object' && !Array.isArray(entries)) {
          for (const [path, value] of Object.entries(entries as Record<string, unknown>)) {
            const record = value as Partial<WatermarkFacts> | null
            if (
              record !== null &&
              typeof record === 'object' &&
              typeof record['bytes'] === 'number' && Number.isFinite(record['bytes']) &&
              typeof record['mtimeMs'] === 'number' && Number.isFinite(record['mtimeMs']) &&
              typeof record['offset'] === 'number' && Number.isFinite(record['offset']) &&
              typeof record['optionsKey'] === 'string' &&
              typeof record['at'] === 'number' && Number.isFinite(record['at'])
            ) {
              loaded[path] = {
                bytes: record['bytes']!,
                mtimeMs: record['mtimeMs']!,
                offset: record['offset']!,
                optionsKey: record['optionsKey']!,
                at: record['at']!,
              }
            }
          }
        }
      }
    } catch {
      // Missing or unreadable journal: start empty; the next save rewrites it.
    }
    this.journal = loaded
    return loaded
  }

  /** Mirror the cache's watermarks into the journal, drop entries for logs
   *  that left the enumeration, and persist when the content changed. */
  private syncJournal(): void {
    if (this.watermarkPath === undefined) return
    const journal = this.loadJournal()
    const seen = new Set<string>()
    for (const [path, entry] of this.cache) {
      seen.add(path)
      const existing = journal[path]
      if (
        existing === undefined ||
        existing.bytes !== entry.bytes ||
        existing.mtimeMs !== entry.mtimeMs ||
        existing.offset !== entry.decodedTo ||
        existing.optionsKey !== entry.optionsKey
      ) {
        journal[path] = {
          bytes: entry.bytes,
          mtimeMs: entry.mtimeMs,
          offset: entry.decodedTo,
          optionsKey: entry.optionsKey,
          at: Date.now(),
        }
      }
    }
    for (const path of Object.keys(journal)) {
      if (!seen.has(path)) delete journal[path]
    }
    // Persist atomically with the host store's privacy posture: 0700
    // directory, 0600 file, tmp+rename. Best effort — an unwritable home
    // loses only the record, never data, and a failure is not fatal.
    const capped = Object.entries(journal)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, JOURNAL_MAX_ENTRIES)
    const serialized = JSON.stringify({ version: 1, entries: Object.fromEntries(capped) })
    if (serialized === this.journalSaved) return
    try {
      mkdirSync(dirname(this.watermarkPath), { recursive: true, mode: 0o700 })
      const temporary = `${this.watermarkPath}.tmp`
      writeFileSync(temporary, serialized, { mode: 0o600, flag: 'w' })
      renameSync(temporary, this.watermarkPath)
      this.journalSaved = serialized
    } catch {
      // Leave the in-memory journal live; a later sweep retries the write.
      this.journalSaved = undefined
    }
  }

  /** Cached sessions whose log still matches the cache token. */
  private cached(facts: LogFacts, optionsKey: string): ScannedSession | undefined {
    const entry = this.cache.get(facts.path)
    if (entry === undefined) return undefined
    if (entry.bytes !== facts.bytes || entry.mtimeMs !== facts.mtimeMs) return undefined
    if (entry.optionsKey !== optionsKey) return undefined
    return entry.session
  }

  /**
   * Decode one log into its cache content.
   *
   * With a resumable cache entry (same options, matching encoding, a
   * watermark that is still a frame/line boundary of the current file, and
   * a matching sampled digest of the bytes before it), only the frames or
   * lines BEYOND the watermark are decoded, folded into a
   * clone of the cached state; every other case decodes from zero. Frames
   * are decoded one at a time; after every 64 frames (and inside very large
   * plain logs) the event loop gets a turn and the abort signal is honored.
   * A frame that fails to decode is skipped; the scan never throws. On
   * abort the clone is discarded and the cached state stays untouched.
   */
  private async decodeLog(
    id: string,
    facts: LogFacts,
    options: ExtractOptions,
    signal: AbortSignal | undefined,
    progress: { resolved: number; total: number | undefined; decodedBytes: number; resumed: number },
    resume: CacheEntry | undefined,
  ): Promise<DecodedLog | undefined> {
    if (facts.bytes > MAX_LOG_BYTES) return undefined
    const buffer = readWholeFile(facts.path)
    if (buffer === undefined) return undefined

    const isZstd = sniffEncoding(buffer.subarray(0, 4), Math.min(4, buffer.length)) === 'zstd'
    let state = newExtractState()
    let decodedTo = 0

    if (isZstd) {
      // The walk is structural, not a decode — cheap even over the whole
      // file, and it doubles as the watermark's boundary proof: some
      // complete frame of the current file ends exactly at the watermark.
      // The boundary alone cannot tell an append from a same-boundary
      // equal-length rewrite, so the sampled prefix digest must also
      // match before the cached fold is trusted.
      const frames = walkFrames(buffer)
      let startIndex = 0
      if (
        resume !== undefined &&
        resume.isZstd &&
        facts.bytes >= resume.decodedTo &&
        frames.some(frame => frame.end === resume.decodedTo) &&
        resume.prefixDigest === prefixDigest(buffer, resume.decodedTo)
      ) {
        startIndex = frames.findIndex(frame => frame.end === resume.decodedTo) + 1
        decodedTo = resume.decodedTo
        state = cloneState(resume.state)
        progress.resumed += 1
      }
      let sinceYield = 0
      for (let index = startIndex; index < frames.length; index++) {
        if (signal?.aborted) return undefined
        const frame = frames[index]!
        const lines = decodeFrame(buffer, frame)
        if (lines !== undefined) {
          for (const line of lines) extractLine(state, line, options)
        }
        decodedTo = frame.end
        progress.decodedBytes += frame.end - frame.start
        if (++sinceYield >= 64) {
          sinceYield = 0
          await yieldToLoop()
        }
      }
    } else {
      // Plain resume boundary: the watermark must sit right after a
      // newline of the current file (decodedTo 0 is the trivial one), and
      // the sampled prefix digest must still match — a newline at the
      // boundary alone would let an equal-length rewrite of the decoded
      // prefix resume on stale fold state.
      let startOffset = 0
      if (
        resume !== undefined &&
        !resume.isZstd &&
        buffer.length >= resume.decodedTo &&
        (resume.decodedTo === 0 || buffer[resume.decodedTo - 1] === 0x0a) &&
        resume.prefixDigest === prefixDigest(buffer, resume.decodedTo)
      ) {
        startOffset = resume.decodedTo
        decodedTo = startOffset
        state = cloneState(resume.state)
        if (startOffset > 0) progress.resumed += 1
      }
      const firstOffset = decodedTo
      let sinceYield = 0
      for (const { line, end } of plainLines(buffer, startOffset)) {
        if (signal?.aborted) return undefined
        decodedTo = end
        if (line !== undefined) extractLine(state, line, options)
        if (++sinceYield >= PLAIN_YIELD_EVERY_LINES) {
          sinceYield = 0
          await yieldToLoop()
        }
      }
      // Account only the range this sweep actually read lines over (the
      // zstd path accounts per decoded frame the same way).
      progress.decodedBytes += buffer.length - firstOffset
    }

    const session: ScannedSession = {
      id,
      path: facts.path,
      bytes: facts.bytes,
      modifiedAt: facts.mtimeMs,
      title: state.title,
      header: state.header,
      messages: state.messages,
    }
    return { session, state, decodedTo, prefixDigest: prefixDigest(buffer, decodedTo), isZstd }
  }

  /**
   * Sweep every root and resolve each session to its searchable content.
   *
   * Cache hits are verified against the live stat (one per session per
   * sweep) and returned without any log read. A log that grew (or was
   * touched) since its cached version resumes from the entry's offset
   * watermark and decodes only the new frames or lines — see decodeLog —
   * and anything that cannot prove the append-only prefix falls back to a
   * full decode. Cold entries are decoded one file at a time with the event
   * loop yielded between them, and the cache is filled incrementally — an
   * aborted sweep keeps everything it already resolved and leaves the warm
   * entries it never reached for the next sweep to re-verify. Sessions
   * whose log vanished between enumeration and read are simply absent from
   * the result.
   *
   * @returns Sessions ordered most-recently-modified first.
   */
  async scan(options: ScanOptions = {}): Promise<ScannedSession[]> {
    const signal = options.signal
    const extract: ExtractOptions = {
      indexTools: options.indexTools ?? DEFAULT_EXTRACT_OPTIONS.indexTools,
      indexThinking: options.indexThinking ?? DEFAULT_EXTRACT_OPTIONS.indexThinking,
      maxMessageChars: options.maxMessageChars ?? DEFAULT_EXTRACT_OPTIONS.maxMessageChars,
    }
    const enumerated = enumerateLogs(options.sessionRoot)
    // Mutable accumulation; only frozen snapshots cross the callback.
    const progress: { resolved: number; total: number | undefined; decodedBytes: number; resumed: number } = {
      resolved: 0,
      total: undefined,
      decodedBytes: 0,
      resumed: 0,
    }

    const results: ScannedSession[] = []
    const optionsKey = JSON.stringify(extract)
    let index = 0
    for (const [id, facts] of enumerated) {
      if (signal?.aborted) break
      progress.total = enumerated.size
      const cachedSession = this.cached(facts, optionsKey)
      let session = cachedSession
      if (session === undefined) {
        // The old entry (if any) is the resume candidate only when the
        // extraction options still match — a switch flip rebuilds from zero.
        const resumeEntry = this.cache.get(facts.path)
        const resume =
          resumeEntry !== undefined && resumeEntry.optionsKey === optionsKey ? resumeEntry : undefined
        const decoded = await this.decodeLog(id, facts, extract, signal, progress, resume)
        if (decoded !== undefined) {
          this.cache.set(facts.path, {
            bytes: facts.bytes,
            mtimeMs: facts.mtimeMs,
            optionsKey,
            decodedTo: decoded.decodedTo,
            prefixDigest: decoded.prefixDigest,
            isZstd: decoded.isZstd,
            state: decoded.state,
            session: decoded.session,
          })
          session = decoded.session
        }
      }
      index += 1
      if (session === undefined) {
        options.onProgress?.({ ...progress, resolved: progress.resolved })
        continue
      }
      results.push(session)
      progress.resolved += 1
      options.onProgress?.({ ...progress })
      if (index % 8 === 0) await yieldToLoop()
    }
    options.onProgress?.({ ...progress, total: progress.total ?? results.length })

    // Garbage-collect entries for logs this sweep no longer enumerates —
    // the cache must not outlive the sessions it mirrors. Entries for logs
    // still enumerated are kept even when this sweep aborted before
    // reaching them or their read failed transiently: an entry is only ever
    // served after a live stat re-verified its bytes:mtimeMs:optionsKey
    // token, so an unreached entry is warm cache, not stale data, and an
    // aborted sweep must not discard the previous sweep's work.
    const enumeratedPaths = new Set<string>()
    for (const facts of enumerated.values()) enumeratedPaths.add(facts.path)
    for (const path of [...this.cache.keys()]) {
      if (!enumeratedPaths.has(path)) this.cache.delete(path)
    }

    // The watermark journal mirrors the committed cache entries; failures
    // are contained inside and never fail the sweep.
    this.syncJournal()

    return results.sort(
      (left, right) =>
        right.modifiedAt - left.modifiedAt ||
        (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
  }

  /** Entries currently held (diagnostics only; no liveness implied). */
  get size(): number {
    return this.cache.size
  }
}
