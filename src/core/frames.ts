/**
 * Zero-dependency reader for the dsh session-log container: an append-only
 * chain of independently decodable Zstandard frames (RFC 8878), one per
 * durable append batch, over UTF-8 JSONL content.
 *
 * Why a structural frame walk instead of scanning for the frame magic
 * (0xFD2FB528): a magic scan is a heuristic — any four bytes of compressed
 * payload can spell the magic — and it cannot answer the one question a
 * tolerant reader must ask: "is the frame at the end of the file complete,
 * or did a writer crash mid-flush?". Walking the Frame_Header and Block
 * chain per RFC 8878 §3.1.1 answers that exactly and jumps frame-to-frame.
 *
 * Why not Node's own zstd APIs: `zstdDecompressSync` and
 * `createZstdDecompress` stop at the end of the FIRST frame. They decode a
 * frame; they do not traverse a chain. Each frame is therefore handed to
 * `zstdDecompressSync` individually (maxOutputLength-capped) and the
 * per-frame outputs are concatenated by the caller.
 *
 * Plain `session.jsonl` logs (a `compression:"none"` backend) are read by
 * the same pipeline with the frame layer skipped.
 *
 * Read-only by contract: this module opens files 'r' and never writes.
 *
 * @module dsh-tui-find/core/frames
 */
import { zstdDecompressSync } from 'node:zlib'

/** Zstandard frame magic, little-endian (RFC 8878 §3.1.1.1). */
export const ZSTD_MAGIC = 0xfd2fb528

/** A frame must not expand past this ceiling when decoded. */
export const MAX_DECODED_FRAME_BYTES = 64 * 1024 * 1024

/** Byte range of one structurally complete frame; `end` is exclusive. */
export interface FrameRange {
  readonly start: number
  readonly end: number
}

/** One decoded log line, still untyped — the caller owns interpretation. */
export type LogLine = Record<string, unknown>

/**
 * Locate the end of the frame starting at `start`, without decompressing it.
 *
 * The walk reads the Frame_Header (descriptor, optional window/dictionary/
 * content-size fields) and then each Block_Header in turn — a 3-byte
 * little-endian word carrying `last_block` (1 bit), `block_type` (2 bits)
 * and `block_size` (21 bits) — until the block marked last. A `Reserved`
 * block type means these bytes are not a frame at all, which is how a
 * coincidental magic gets rejected.
 *
 * @param buffer - Bytes available to the reader (may end mid-frame).
 * @param start - Offset of the candidate frame's magic.
 * @returns The frame's exclusive end offset, or -1 when the bytes at `start`
 *   are not a structurally complete frame within `buffer`.
 */
export function frameEnd(buffer: Buffer, start: number): number {
  let at = start
  if (at < 0 || at + 5 > buffer.length) return -1
  if (buffer.readUInt32LE(at) !== ZSTD_MAGIC) return -1
  at += 4

  const descriptor = buffer[at]!
  at += 1
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const hasChecksum = (descriptor >> 2) & 1
  const dictionaryIdFlag = descriptor & 3

  // Window_Descriptor is present only when the frame is not single-segment.
  if (singleSegment === 0) at += 1
  at += [0, 1, 2, 4][dictionaryIdFlag]!
  // Frame_Content_Size: absent (0) unless single-segment, where it is 1 byte.
  at += contentSizeFlag === 0 ? singleSegment : [0, 2, 4, 8][contentSizeFlag]!
  if (at > buffer.length) return -1

  for (;;) {
    if (at + 3 > buffer.length) return -1
    const header = buffer[at]! | (buffer[at + 1]! << 8) | (buffer[at + 2]! << 16)
    at += 3
    const isLast = header & 1
    const blockType = (header >> 1) & 3
    const blockSize = header >>> 3
    // 3 = Reserved. Never emitted by an encoder, so this is not a frame.
    if (blockType === 3) return -1
    // An RLE block stores one byte and repeats it `blockSize` times; Raw and
    // Compressed blocks store `blockSize` bytes verbatim.
    at += blockType === 1 ? 1 : blockSize
    if (at > buffer.length) return -1
    if (isLast === 1) break
  }

  if (hasChecksum === 1) at += 4
  return at <= buffer.length ? at : -1
}

/**
 * Walk complete frames forward from `from`.
 *
 * @param buffer - Bytes to walk.
 * @param from - Offset to start at (must be a frame boundary).
 * @param maxFrames - Stop after this many frames; the reader's cost ceiling.
 * @returns Complete frames in file order. A window that ends mid-frame
 *   simply yields one fewer frame — the partial tail is never reported as
 *   complete.
 */
export function walkFrames(
  buffer: Buffer,
  from = 0,
  maxFrames = Number.POSITIVE_INFINITY,
): FrameRange[] {
  const frames: FrameRange[] = []
  let at = from
  while (at < buffer.length && frames.length < maxFrames) {
    const end = frameEnd(buffer, at)
    if (end < 0) break
    frames.push({ start: at, end })
    at = end
  }
  return frames
}

/**
 * Decode one frame to JSON log lines, tolerantly.
 *
 * A frame that fails to decompress is skipped rather than thrown: a log
 * being appended to right now can hold a frame flushed without its final
 * checksum, and a torn tail is the backend's own documented recovery case.
 * A line that fails to parse rejects the WHOLE frame — a frame is the
 * backend's atomic write unit, so a broken line inside a structurally
 * complete frame is corruption, not a torn write, and the frame's remaining
 * lines cannot be trusted.
 *
 * @param buffer - Bytes the frames index into.
 * @param frame - One complete frame range within `buffer`.
 * @returns Parsed envelopes in log order, or undefined when the frame does
 *   not decode.
 */
export function decodeFrame(buffer: Buffer, frame: FrameRange): LogLine[] | undefined {
  let text: string
  try {
    text = zstdDecompressSync(buffer.subarray(frame.start, frame.end), {
      maxOutputLength: MAX_DECODED_FRAME_BYTES,
    }).toString('utf8')
  } catch {
    return undefined
  }
  const lines: LogLine[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        lines.push(parsed as LogLine)
      }
    } catch {
      return undefined
    }
  }
  return lines
}

/**
 * Sniff a file's encoding from its first four bytes: the zstd magic declares
 * a frame chain; anything else (including an empty file) is plain JSONL.
 * The caller owns the open/close; `undefined` is returned when the short
 * read could not even reach four bytes — which for a non-empty file means
 * treat it as plain text rather than give up entirely.
 *
 * @param head - The first ≤4 bytes of the file.
 * @param bytesRead - How many of those bytes are valid.
 */
export function sniffEncoding(head: Buffer, bytesRead: number): 'zstd' | 'plain' {
  return bytesRead === 4 && head.readUInt32LE(0) === ZSTD_MAGIC ? 'zstd' : 'plain'
}
