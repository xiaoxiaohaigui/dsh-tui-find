/**
 * Log-envelope → indexable content. One pass over a session's decoded
 * envelopes extracts what the search indexes:
 *
 * - the session title (LAST `session/title` wins, mirroring the picker's
 *   last-write-wins rename semantics),
 * - human `user/message` text (plugin injections, instruction snapshots and
 *   sub-agent reports also arrive as user-role messages; `source.kind` is
 *   the discriminator, absence of a source means human, matching the TUI's
 *   own `isHumanSource`),
 * - `assistant/message` text blocks (thinking blocks are skipped unless
 *   indexing for them is explicitly enabled — noisy and private by default),
 * - optional `tool/call` summaries (`[name] arguments`), off by default.
 *
 * Every text is truncated to a per-message char budget so one giant paste or
 * one enormous tool result cannot dominate the index. Envelopes with
 * `ignorable: true` are skipped (the read path's own skip signal), and the
 * header row (`type:'session'`, or a type-less first line in the legacy
 * shape) carries `cwd`/`createdAt` for the same-repo filter, which the log is
 * the authority for.
 *
 * @module dsh-tui-find/core/events
 */
import type { LogLine } from './frames.js'

/** One searchable conversation message. */
export interface IndexedMessage {
  /** Envelope seq; undefined is legal (log-only plugin events). */
  readonly seq: number | undefined
  readonly role: 'user' | 'assistant' | 'tool'
  readonly text: string
  /** Epoch-ms from the envelope, when it carries one. */
  readonly at: number | undefined
}

/** What one session log yields for the index. */
export interface SessionContent {
  readonly title: string | undefined
  /** Header facts when the log's first (header) row carried them. */
  readonly header: { readonly cwd: string | undefined; readonly createdAt: number | undefined }
  readonly messages: readonly IndexedMessage[]
}

/** Extraction switches (wired from plugin config). */
export interface ExtractOptions {
  readonly indexTools: boolean
  readonly indexThinking: boolean
  /** Per-message text cap, in characters. */
  readonly maxMessageChars: number
}

export const DEFAULT_EXTRACT_OPTIONS: ExtractOptions = {
  indexTools: false,
  indexThinking: false,
  maxMessageChars: 4000,
}

/** A finite number, or undefined for anything else (NaN and ±Infinity included). */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Indexed text carries no control characters: a raw ESC/BEL/C1 byte in a
 * message body would be written to the terminal verbatim by the scene —
 * escape injection, up to an OSC 52 clipboard overwrite — and CR/tab break
 * the rows' column math (the list path collapses whitespace, but the preview
 * pane honors newlines). Newline is the one control the preview needs; CR and
 * tab degrade to printable whitespace; every other Cc is dropped. `JSON.stringify`
 * escapes below 0x20 but passes U+007F–U+009F through, so tool summaries go
 * through this too.
 */
function sanitizeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[^\P{Cc}\n]/gu, '')
}

/** A sanitized, trimmed non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = sanitizeText(value).trim()
  return cleaned.length > 0 ? cleaned : undefined
}

/**
 * The concatenated text of every block the index cares about. Content is
 * normally a block array (`{type:'text'|'reasoning'|…}`, each with its payload
 * field); a bare string is accepted defensively, matching the TUI's readers.
 * Thinking blocks have been observed under both names — `reasoning` in the
 * current harness logs, `thinking` in earlier shapes — so when thinking
 * indexing is enabled both block types are honored.
 */
function textOfBlocks(content: unknown, thinking: boolean): string | undefined {
  if (typeof content === 'string') {
    const cleaned = sanitizeText(content).trim()
    return cleaned.length > 0 ? cleaned : undefined
  }
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record['type'] === 'text') {
      const value = record['text']
      if (typeof value === 'string') {
        const cleaned = sanitizeText(value).trim()
        if (cleaned.length > 0) parts.push(cleaned)
      }
      continue
    }
    if (thinking && (record['type'] === 'reasoning' || record['type'] === 'thinking')) {
      const value = record['text'] ?? record['thinking']
      if (typeof value === 'string') {
        const cleaned = sanitizeText(value).trim()
        if (cleaned.length > 0) parts.push(cleaned)
      }
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * Whether a message's `source` marks it as typed by the person at the
 * keyboard. Plugin injections, instruction snapshots, skill catalogues and
 * sub-agent reports all arrive as user-role messages too, and indexing them
 * would pollute every query. Absence of a source means human — the TUI's
 * own `isHumanSource` treats undefined/null the same way.
 */
function isHumanSource(source: unknown): boolean {
  if (source === undefined || source === null) return true
  if (typeof source !== 'object') return false
  return (source as Record<string, unknown>)['kind'] === 'user'
}

/**
 * The human prompt carried by a `user/message` line.
 *
 * `agent/inbox/spliced` deliberately does NOT count: an inbox delivery
 * writes the splice event FIRST and the durable `user/message` afterwards
 * (the host's digest reads the splice only because it scans the head
 * window before the durable form lands), so indexing both would double-
 * count every queued/steered message. The host's own session-tree reader
 * skips the splice for the same reason.
 */
function humanPrompt(line: LogLine, options: ExtractOptions): string | undefined {
  const data = line['data']
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>

  if (line['type'] === 'user/message') {
    return isHumanSource(record['source'])
      ? textOfBlocks(record['content'], options.indexThinking)
      : undefined
  }
  return undefined
}

/** The tool summary carried by a `tool/call` line, as `[name] arguments`. */
function toolSummary(line: LogLine, limit: number): string | undefined {
  const data = line['data']
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const name = text(record['name'])
  if (name === undefined) return undefined
  const rawArgs = record['arguments']
  let args: string | undefined
  if (typeof rawArgs === 'string') args = rawArgs
  else if (rawArgs !== undefined && rawArgs !== null) {
    try {
      args = JSON.stringify(rawArgs)
    } catch {
      args = undefined
    }
  }
  const body = args === undefined ? '' : ` ${args.slice(0, Math.max(0, limit))}`
  return sanitizeText(`[${name}]${body}`)
}

/**
 * Fold one decoded log line into the accumulating index.
 *
 * Returns the (possibly appended-to) messages array; the caller owns the
 * array across lines. `title`/`header` are written through `state`.
 */
export interface ExtractState {
  title: string | undefined
  header: { cwd: string | undefined; createdAt: number | undefined }
  messages: IndexedMessage[]
}

export function newExtractState(): ExtractState {
  return { title: undefined, header: { cwd: undefined, createdAt: undefined }, messages: [] }
}

/**
 * Interpret one line. Unknown event types are skipped — the log's own
 * fail-closed rule ("likely written by a newer harness") applies to session
 * reconstruction, not to read-only search: a search index that refuses a
 * whole session over one unfamiliar type would hide more than it protects.
 */
export function extractLine(state: ExtractState, line: LogLine, options: ExtractOptions): void {
  if (line['ignorable'] === true) return
  const seq = finiteNumber(line['seq'])
  const at = finiteNumber(line['time'])
  const type = line['type']

  // The header row. The real harness writes it as `{type:'session', …}` with
  // `cwd`/`createdAt` at the TOP LEVEL (no `seq`, no `data`); a type-less
  // first row is accepted as the legacy shape. Either way the row carries no
  // conversation text, and its `id` is not searchable.
  if (type === 'session' || type === undefined) {
    const cwd = text(line['cwd'])
    if (cwd !== undefined && state.header.cwd === undefined) state.header.cwd = cwd
    const createdAt = finiteNumber(line['createdAt'])
    if (createdAt !== undefined && state.header.createdAt === undefined) {
      state.header.createdAt = createdAt
    }
    return
  }

  if (type === 'session/title') {
    const data = line['data']
    if (data !== null && typeof data === 'object') {
      const title = text((data as Record<string, unknown>)['title'])
      // LAST title wins — a /rename append overrides the auto title.
      if (title !== undefined) state.title = title
    }
    return
  }

  if (type === 'user/message') {
    const prompt = humanPrompt(line, options)
    if (prompt !== undefined) {
      state.messages.push({ seq, role: 'user', text: prompt.slice(0, options.maxMessageChars), at })
    }
    return
  }

  if (type === 'assistant/message') {
    const data = line['data']
    if (data === null || typeof data !== 'object') return
    const message = (data as Record<string, unknown>)['message']
    if (message === null || typeof message !== 'object') return
    const content = (message as Record<string, unknown>)['content']
    const body = textOfBlocks(content, options.indexThinking)
    if (body !== undefined) {
      state.messages.push({
        seq,
        role: 'assistant',
        text: body.slice(0, options.maxMessageChars),
        at,
      })
    }
    return
  }

  if (type === 'tool/call' && options.indexTools) {
    const summary = toolSummary(line, options.maxMessageChars)
    if (summary !== undefined) {
      state.messages.push({ seq, role: 'tool', text: summary.slice(0, options.maxMessageChars), at })
    }
  }
}
