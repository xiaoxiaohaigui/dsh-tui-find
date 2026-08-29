#!/usr/bin/env node
/**
 * Fixture generator: synthesizes dsh session logs for offline tests.
 *
 * A session log is an append-only chain of independently decodable zstd
 * frames, one per durable append batch, each holding newline-delimited JSON
 * envelopes — or plain JSONL for a `compression:"none"` backend. `node:zlib`'s
 * `zstdCompressSync` produces exactly one RFC 8878 frame per call, so a frame
 * chain is simply their concatenation. Shapes mirror the real backend:
 *
 *   line 1: the bare SessionHeader (no `type`, no `seq`)
 *   then  : `{ type, seq, time, data, ignorable? }` envelopes
 *
 * Output (default test/fixtures/generated/):
 *   <root>/<workspace>/<session-id>/session.jsonl.zstd   — compressed chain
 *   <root>/<workspace>/<session-id>/session.jsonl        — plain twin
 *   torn.log / oversized.log                             — corruption cases
 *
 * Usage: node scripts/make-fixtures.mjs [outputDir]
 * @module scripts/make-fixtures
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const outRoot = process.argv[2] !== undefined
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/generated')

/**
 * Encode one frame chain: each batch becomes one independently decodable
 * zstd frame; frames are concatenated (the writer's append discipline).
 * Batch elements are already JSON strings — join, never re-encode.
 */
function zstdChain(batches) {
  return Buffer.concat(
    batches.map(batch => zstdCompressSync(Buffer.from(batch.join('\n') + '\n', 'utf8'))),
  )
}

function writeLog(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, bytes, { mode: 0o600 })
}

/** One conversation envelope. */
const env = (type, seq, data, extra = {}) =>
  JSON.stringify({ type, seq, time: 1_750_000_000_000 + seq * 1000, data, ...extra })

/** A header row + conversation, batched the way the backend flushes. */
function conversation({ header, userTexts, assistantTexts, toolTexts = [], splicedFirst = undefined }) {
  const batches = []
  batches.push([JSON.stringify({ version: 0, id: header.id, createdAt: header.createdAt, cwd: header.cwd })])
  const events = []
  let seq = 0
  if (splicedFirst !== undefined) {
    // The inbox delivery writes the splice event BEFORE the durable
    // user/message lands — the same text twice in the log. The index must
    // count it once (see events.ts: the splice is deliberately not indexed).
    seq += 1
    events.push(
      env('agent/inbox/spliced', seq, {
        inserted: [
          { role: 'user', content: [{ type: 'text', text: splicedFirst }], source: { kind: 'user' } },
        ],
      }),
    )
  }
  for (const text of userTexts) {
    seq += 1
    events.push(env('user/message', seq, { content: [{ type: 'text', text }], source: { kind: 'user' } }))
  }
  for (const text of assistantTexts) {
    seq += 1
    events.push(env('assistant/message', seq, { turn: 1, step: seq, message: { role: 'assistant', content: [{ type: 'text', text }] } }))
  }
  for (const { name, args } of toolTexts) {
    seq += 1
    events.push(env('tool/call', seq, { name, arguments: args, callId: `call-${seq}` }))
  }
  // One envelope per batch after the header: several frames per log.
  for (const event of events) batches.push([event])
  return batches
}

const SESSIONS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    workspace: 'd____repo-auth',
    cwd: 'D:/work/repo-auth',
    title: { title: 'fix auth retry backoff', source: { kind: 'provider' } },
    user: ['登录失败重试是不是没加退避？', '再加 jitter'],
    assistant: ['auth middleware 的 retry 用的固定间隔', '改成指数退避 + jitter，见下面的 diff'],
    tools: [{ name: 'edit', args: '{"file_path":"src/auth/retry.ts"}' }],
    spliced: '登录失败重试是不是没加退避？',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    workspace: 'd____repo-payments',
    cwd: 'D:/work/repo-payments',
    title: { title: 'payments refactor plan', source: { kind: 'provider' } },
    user: ['调研一下支付渠道抽象的取舍'],
    assistant: ['在 payments/gateway 里注入 trace id，结论是适配器模式'],
    tools: [],
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    workspace: 'd____repo-auth',
    cwd: 'D:/work/repo-auth/submodule',
    title: undefined,
    user: ['子目录会话：auth 子包的依赖怎么收敛'],
    assistant: ['用 workspace 协议收敛依赖'],
    tools: [],
  },
]

let manifest = { root: outRoot, sessions: [], corruption: {} }

for (const session of SESSIONS) {
  const header = { id: session.id, createdAt: 1_750_000_000_000, cwd: session.cwd }
  const batches = conversation({
    header,
    userTexts: session.user,
    assistantTexts: session.assistant,
    toolTexts: session.tools,
    // Session 1 delivers its first prompt through the inbox, exercising the
    // splice-before-durable double-write the index must de-duplicate.
    splicedFirst: session.spliced,
  })
  if (session.title !== undefined) {
    batches.push([env('session/title', 900, session.title)])
  }
  const base = join(outRoot, session.workspace, session.id)
  const compressed = zstdChain(batches)
  writeLog(join(base, 'session.jsonl.zstd'), compressed)
  // The plain twin mirrors the SAME conversation under a different session
  // id: the scanner keeps one log per session id (compressed wins), so the
  // plain format needs its own ids to be enumerated at all.
  const plainId = session.id.replace(/^(\d\d)/, m => String(99 - Number(m)))
  const plainHeader = { ...header, id: plainId }
  const plainBatches = conversation({
    header: plainHeader,
    userTexts: session.user,
    assistantTexts: session.assistant,
    toolTexts: session.tools,
  })
  if (session.title !== undefined) {
    plainBatches.push([env('session/title', 900, session.title)])
  }
  const plain = Buffer.from(plainBatches.flat().map(line => line + '\n').join(''), 'utf8')
  const plainBase = join(outRoot, `${session.workspace}-plain`, plainId)
  writeLog(join(plainBase, 'session.jsonl'), plain)
  manifest.sessions.push({
    id: session.id,
    plainId,
    compressedPath: join(base, 'session.jsonl.zstd'),
    plainPath: join(plainBase, 'session.jsonl'),
    bytes: compressed.length,
    plainBytes: plain.length,
  })
}

// Corruption case A: a clean chain with a torn final frame (crash mid-flush).
const tornBatches = conversation({
  header: { id: '44444444-4444-4444-8444-444444444444', createdAt: 1_750_000_000_000, cwd: 'D:/work/repo-auth' },
  userTexts: ['torn tail session 回归测试'],
  assistantTexts: ['写一半就崩了的回答'],
})
const tornFull = zstdChain(tornBatches)
const lastFrameStart = tornFull.length - zstdCompressSync(
  Buffer.from(tornBatches[tornBatches.length - 1].map(l => l + '\n').join(''), 'utf8'),
).length
const torn = Buffer.from(tornFull.subarray(0, lastFrameStart + Math.floor((tornFull.length - lastFrameStart) / 2)))
manifest.corruption.tornPath = join(outRoot, 'd____corrupt', '44444444-4444-4444-8444-444444444444', 'session.jsonl.zstd')
writeLog(manifest.corruption.tornPath, torn)

// Corruption case B: pure garbage at a frame boundary (no complete frame).
manifest.corruption.garbagePath = join(outRoot, 'd____corrupt', '55555555-5555-5555-8555-555555555555', 'session.jsonl.zstd')
writeLog(manifest.corruption.garbagePath, Buffer.from('not a zstd log at all\n', 'utf8'))

manifest.corruption.tornPlainPath = join(outRoot, 'd____corrupt-plain', '66666666-6666-6666-8666-666666666666', 'session.jsonl')
writeLog(
  manifest.corruption.tornPlainPath,
  Buffer.from(
    JSON.stringify({ version: 0, id: '66666666-6666-6666-8666-666666666666', createdAt: 1, cwd: 'D:/work/x' }) +
      '\n' + env('user/message', 1, { content: [{ type: 'text', text: '完整的行' }], source: { kind: 'user' } }) +
      '\n{"type": "user/message", "seq": 2', // torn final line
    'utf8',
  ),
)

writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`fixtures written to ${outRoot}`)
console.log(`  sessions: ${manifest.sessions.length} (compressed + plain twins)`)
console.log(`  corruption: torn frame, garbage, torn plain line`)
