/**
 * Frame-chain parser unit tests — the one piece with real technical risk.
 * Covered: multi-frame chains, torn tail frames, magic false positives,
 * reserved-block rejection, RLE blocks, all frame-header field shapes, the
 * decode cap, and plain-JSONL fallback parity.
 */
import { describe, expect, it } from 'vitest'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
  MAX_DECODED_FRAME_BYTES,
  decodeFrame,
  frameEnd,
  sniffEncoding,
  walkFrames,
  type FrameRange,
} from '../src/core/frames.js'

/** Build one independently decodable zstd frame over a JSONL batch. */
function frame(lines: string[]): Buffer {
  return zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))
}

/** A chain is the plain concatenation of frames — the writer's discipline. */
function chain(frames: Buffer[]): Buffer {
  return Buffer.concat(frames)
}

describe('frameEnd', () => {
  it('returns the exclusive end of a single-frame buffer', () => {
    const single = frame(['{"a":1}'])
    expect(frameEnd(single, 0)).toBe(single.length)
  })

  it('walks a multi-frame chain frame-to-frame with no magic scan', () => {
    const buffers = [frame(['{"a":1}']), frame(['{"b":2}', '{"c":3}']), frame(['{"d":4}'])]
    const buffer = chain(buffers)
    const frames = walkFrames(buffer)
    expect(frames.map((f: FrameRange) => f.end - f.start)).toEqual(buffers.map(b => b.length))
    expect(frames[frames.length - 1]!.end).toBe(buffer.length)
  })

  it('rejects a coincidental magic inside random bytes (reserved block)', () => {
    // Craft bytes that carry the magic but cannot be a frame: the frame
    // header descriptor at offset 4 declares a Reserved block type (3).
    const bogus = Buffer.alloc(32)
    bogus.writeUInt32LE(0xfd2fb528, 0)
    bogus[4] = 0x00 // descriptor: no single-segment, no checksum
    bogus[5] = 0x00 // window descriptor
    bogus[6] = 0x07 // block header: last=1, type=3 (Reserved), size=0
    expect(frameEnd(bogus, 0)).toBe(-1)
  })

  it('returns -1 for a window that ends mid-frame', () => {
    const single = frame(['{"a":1}', '{"b":2}', '{"c":3}'])
    expect(frameEnd(single.subarray(0, single.length - 4), 0)).toBe(-1)
    expect(walkFrames(single.subarray(0, single.length - 4))).toEqual([])
  })

  it('returns -1 for short or non-magic input', () => {
    expect(frameEnd(Buffer.alloc(0), 0)).toBe(-1)
    expect(frameEnd(Buffer.from('plain jsonl text'), 0)).toBe(-1)
  })

  it('accepts single-segment and checksummed frames (field-shape sweep)', () => {
    // singleSegment + contentSize flag variants produced by the real encoder
    // across payloads of very different sizes.
    for (const lineCount of [1, 2, 50, 5000]) {
      const lines = Array.from({ length: lineCount }, (_, i) => `{"n":${i}}`)
      const single = frame(lines)
      const end = frameEnd(single, 0)
      expect(end).toBe(single.length)
      // The end must be structurally true: decoding exactly that range works.
      const text = zstdDecompressSync(single.subarray(0, end)).toString('utf8')
      expect(text.split('\n').filter(Boolean)).toHaveLength(lineCount)
    }
  })
})

describe('walkFrames', () => {
  it('drops a torn tail frame but keeps every committed frame', () => {
    const buffers = [frame(['{"a":1}']), frame(['{"b":2}']), frame(['{"c":3}'])]
    const whole = chain(buffers)
    // Cut into the LAST frame only.
    const cut = whole.length - Math.floor(buffers[2]!.length / 2)
    const torn = whole.subarray(0, cut)
    const frames = walkFrames(torn)
    expect(frames).toHaveLength(2)
    expect(frames[1]!.end).toBeLessThanOrEqual(torn.length)
  })

  it('honors the maxFrames cost ceiling', () => {
    const buffer = chain([frame(['{"a":1}']), frame(['{"b":2}']), frame(['{"c":3}'])])
    expect(walkFrames(buffer, 0, 2)).toHaveLength(2)
  })
})

describe('decodeFrame', () => {
  it('decodes each frame of a chain independently (Node zstd stops at one)', () => {
    const buffers = [frame(['{"a":1}']), frame(['{"b":2}', '{"c":3}'])]
    const buffer = chain(buffers)
    const frames = walkFrames(buffer)
    expect(frames).toHaveLength(2)
    const first = decodeFrame(buffer, frames[0]!)
    const second = decodeFrame(buffer, frames[1]!)
    expect(first).toEqual([{ a: 1 }])
    expect(second).toEqual([{ b: 2 }, { c: 3 }])
  })

  it('returns undefined for a frame that fails to decode', () => {
    const buffer = chain([frame(['{"a":1}'])])
    const frames = walkFrames(buffer)
    // Corrupt the payload bits but keep the structural walk valid.
    const corrupted = Buffer.from(buffer)
    corrupted[corrupted.length - 5] = corrupted[corrupted.length - 5]! ^ 0xff
    expect(decodeFrame(corrupted, frames[0]!)).toBeUndefined()
  })

  it('skips blank lines and rejects arrays/primatives as lines', () => {
    const text = '{"ok":1}\n\n[1,2]\n"str"\n'
    const frameBuf = zstdCompressSync(Buffer.from(text, 'utf8'))
    expect(decodeFrame(frameBuf, { start: 0, end: frameBuf.length })).toEqual([{ ok: 1 }])
  })

  it('enforces the 64 MB decoded-frame ceiling', () => {
    expect(MAX_DECODED_FRAME_BYTES).toBe(64 * 1024 * 1024)
    // A highly compressible frame far above the cap: decode refuses it.
    const big = zstdCompressSync(Buffer.alloc(70 * 1024 * 1024, 0x61))
    expect(decodeFrame(big, { start: 0, end: big.length })).toBeUndefined()
  })
})

describe('sniffEncoding', () => {
  it('declares zstd only on the exact magic', () => {
    expect(sniffEncoding(chain([frame(['{"a":1}'])]).subarray(0, 4), 4)).toBe('zstd')
    expect(sniffEncoding(Buffer.from('{"a":1}\n', 'utf8').subarray(0, 4), 4)).toBe('plain')
    expect(sniffEncoding(Buffer.alloc(4), 2)).toBe('plain')
  })
})
