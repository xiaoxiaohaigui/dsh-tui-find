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
 * @module dsh-tui-find/core/scan
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeFrame, sniffEncoding, walkFrames, type LogLine } from './frames.js'
import {
  DEFAULT_EXTRACT_OPTIONS,
  extractLine,
  newExtractState,
  type ExtractOptions,
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
  /** Log bytes decoded so far in this sweep (cache misses only). */
  readonly decodedBytes: number
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
  readonly session: ScannedSession
}

/** Upper bound on a single log we will read whole; beyond it the session is
 * skipped with its header facts only. (A 128 MB conversation log is far
 * outside anything the format produces in practice; the cap is a seatbelt.) */
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
        // Compressed wins when both encodings exist (host's own preference).
        const compressed = join(dir, 'session.jsonl.zstd')
        const plain = join(dir, 'session.jsonl')
        const path = existsSync(compressed) ? compressed : existsSync(plain) ? plain : undefined
        if (path === undefined) continue
        try {
          const stats = statSync(path)
          if (!stats.isFile()) continue
          found.set(id, { path, bytes: stats.size, mtimeMs: stats.mtimeMs })
        } catch {
          // A log that vanished mid-enumeration simply is not listed.
        }
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
 * 0x0A byte, so byte-level splitting is encoding-safe. An unterminated
 * final line is a torn write — dropped, not parsed, matching the host's
 * own reader.
 */
function* plainLines(buffer: Buffer): Generator<LogLine> {
  let start = 0
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start)
    if (newline === -1) return // torn tail — uncommitted, dropped
    const end = newline
    if (end > start) {
      try {
        const parsed: unknown = JSON.parse(buffer.toString('utf8', start, end))
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          yield parsed as LogLine
        }
      } catch {
        // One malformed line costs itself only.
      }
    }
    start = newline + 1
  }
}

/** Yield to the event loop so a cold sweep never blocks the render tick. */
function yieldToLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * The scanner. One instance per plugin activation; the cache lives for the
 * process lifetime in memory only (no on-disk index in v0.1 — the spec's
 * privacy posture keeps conversation text out of new files).
 */
export class SessionScanner {
  private readonly cache = new Map<string, CacheEntry>()

  /** Cached sessions whose log still matches the cache token. */
  private cached(id: string, facts: LogFacts, optionsKey: string): ScannedSession | undefined {
    const entry = this.cache.get(facts.path)
    if (entry === undefined) return undefined
    if (entry.bytes !== facts.bytes || entry.mtimeMs !== facts.mtimeMs) return undefined
    if (entry.optionsKey !== optionsKey) return undefined
    return entry.session
  }

  /**
   * Decode one log into a ScannedSession. Frames are decoded one at a time;
   * after every `YIELD_EVERY_FRAMES` frames (and before returning) the event
   * loop gets a turn and the abort signal is honored. A frame that fails to
   * decode is skipped; the scan never throws.
   */
  private async decodeLog(
    id: string,
    facts: LogFacts,
    options: ExtractOptions,
    signal: AbortSignal | undefined,
    progress: { resolved: number; total: number | undefined; decodedBytes: number },
  ): Promise<ScannedSession | undefined> {
    if (facts.bytes > MAX_LOG_BYTES) return undefined
    const buffer = readWholeFile(facts.path)
    if (buffer === undefined) return undefined

    const state = newExtractState()
    const isZstd = sniffEncoding(buffer.subarray(0, 4), Math.min(4, buffer.length)) === 'zstd'
    if (isZstd) {
      const frames = walkFrames(buffer)
      let sinceYield = 0
      for (const frame of frames) {
        if (signal?.aborted) return undefined
        const lines = decodeFrame(buffer, frame)
        if (lines !== undefined) {
          for (const line of lines) extractLine(state, line, options)
        }
        progress.decodedBytes += frame.end - frame.start
        if (++sinceYield >= 64) {
          sinceYield = 0
          await yieldToLoop()
        }
      }
    } else {
      let sinceYield = 0
      for (const line of plainLines(buffer)) {
        if (signal?.aborted) return undefined
        extractLine(state, line, options)
        if (++sinceYield >= PLAIN_YIELD_EVERY_LINES) {
          sinceYield = 0
          await yieldToLoop()
        }
      }
      // Aborted reads report nothing; a completed one accounts the whole
      // buffer, matching the zstd path's per-frame accounting.
      progress.decodedBytes += buffer.length
    }

    return {
      id,
      path: facts.path,
      bytes: facts.bytes,
      modifiedAt: facts.mtimeMs,
      title: state.title,
      header: state.header,
      messages: state.messages,
    }
  }

  /**
   * Sweep every root and resolve each session to its searchable content.
   *
   * Cache hits are verified against the live stat (one per session per
   * sweep) and returned without any log read. Cold entries are decoded one
   * file at a time with the event loop yielded between them, and the cache
   * is filled incrementally — an aborted sweep keeps everything it already
   * resolved and leaves the warm entries it never reached for the next
   * sweep to re-verify. Sessions whose log vanished between enumeration and
   * read are simply absent from the result.
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
    const progress: { resolved: number; total: number | undefined; decodedBytes: number } = {
      resolved: 0,
      total: undefined,
      decodedBytes: 0,
    }

    const results: ScannedSession[] = []
    const optionsKey = JSON.stringify(extract)
    let index = 0
    for (const [id, facts] of enumerated) {
      if (signal?.aborted) break
      progress.total = enumerated.size
      const cachedSession = this.cached(id, facts, optionsKey)
      const session = cachedSession ?? (await this.decodeLog(id, facts, extract, signal, progress))
      index += 1
      if (session === undefined) {
        options.onProgress?.({ ...progress, resolved: progress.resolved })
        continue
      }
      if (cachedSession === undefined) {
        this.cache.set(facts.path, { bytes: facts.bytes, mtimeMs: facts.mtimeMs, optionsKey, session })
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
