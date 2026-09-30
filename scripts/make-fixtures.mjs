#!/usr/bin/env node
/**
 * Fixture generator: synthesizes dsh session logs for offline tests.
 *
 * A session log is an append-only chain of independently decodable zstd
 * frames, one per durable append batch, each holding newline-delimited JSON
 * envelopes — or plain JSONL for a `compression:"none"` backend. `node:zlib`'s
 * `zstdCompressSync` produces exactly one RFC 8878 frame per call, so a frame
 * chain is simply their concatenation. Shapes mirror the real backend
 * (verified against live `~/.dsh/sessions` logs):
 *
 *   line 1: the SessionHeader — `{type:'session', version, id, createdAt,
 *           cwd, …}` with the facts at the TOP LEVEL (a legacy type-less
 *           shape is emitted for one session to pin tolerance for it)
 *   then  : `{ type, seq, time, data, ignorable? }` envelopes
 *
 * Output (default test/fixtures/generated/):
 *   <root>/<workspace>/<session-id>/session.jsonl.zstd   — compressed chain
 *   <root>/<workspace>/<session-id>/session.jsonl        — plain twin
 *   <root>/<workspace>/<session-id>/session.vN.jsonl[.zstd] — generation-N log
 *   torn.log / oversized.log                             — corruption cases
 *
 * Generation naming mirrors the backend's immutable format generations
 * (dsh-session-format's sessionFormatLogFilename): v0 keeps `session.jsonl`,
 * every later generation carries `.vN` before the suffix, and one session
 * directory holds exactly one generation (a migration window may hold more).
 * The live generation is v4 (the 0.12.0 host line writes
 * `session.v4.jsonl.zstd`); v3 is kept as the retired generation so the
 * v3 → v4 migration window stays pinned — a real window holds two COMPRESSED
 * siblings (`session.v3.jsonl.zstd` beside `session.v4.jsonl.zstd`), with the
 * older v0 plaintext artifact still sitting in the same directory.
 *
 * Usage: node scripts/make-fixtures.mjs [--force] [outputDir]
 *
 * The output root is REGENERATED — fixture content is generation-named, so a
 * leftover file from an earlier generation (e.g. a `session.v3.jsonl.zstd`
 * predating a move to v4) would otherwise sit beside the new one and silently
 * change what the suite is reading. What keeps that regeneration safe:
 *
 *   - Only files this script owns are replaced: every path the previous
 *     `manifest.json` recorded, every file matching this script's own shape
 *     (`session*.jsonl*`) under the root, and that `manifest.json`. Unrelated
 *     files in the target (`.git`, notes, foreign logs) are never touched.
 *   - A target directory is accepted only when it is missing, empty, or
 *     already holds this script's `manifest.json`. Anything else (a checkout,
 *     a home directory) is refused with a message instead of being cleared;
 *     `--force` overrides that refusal explicitly.
 *   - Generation is staged: the whole set is written to a sibling temp
 *     directory (`<outputDir>.tmp-<pid>-<stamp>`) and only then moved into
 *     place. A generation failure, or a locked file while landing (a Windows
 *     editor / indexer / antivirus holding a handle), exits non-zero with the
 *     exact path and leaves the previous complete set usable: old files are
 *     moved aside rather than deleted, and are moved back on failure. The
 *     previous `manifest.json` is cleared last and the new one written first,
 *     so even an interrupted landing leaves a directory this script
 *     recognizes and recovers on the next run.
 *
 * @module scripts/make-fixtures
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const USAGE = 'usage: node scripts/make-fixtures.mjs [--force] [outputDir]'

/** Report the reason on stderr and exit non-zero. Callers clean up first:
 *  this helper deletes nothing on its own. */
function fail(...lines) {
  for (const line of lines) console.error(`make-fixtures: ${line}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const flags = args.filter(arg => arg.startsWith('-'))
const positional = args.filter(arg => !arg.startsWith('-'))
const unknownFlags = flags.filter(flag => flag !== '--force')
if (unknownFlags.length > 0) fail(USAGE, `unknown option: ${unknownFlags.join(', ')}`)
if (positional.length > 1) fail(USAGE, `too many output directories: ${positional.join(', ')}`)

/** Explicit override for the overwrite guard below. */
const force = flags.includes('--force')
const outRoot = positional.length === 1
  ? resolve(positional[0])
  : resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/generated')

/** This generator's own output shape — see the module doc. */
const OWNED_FILE_NAME = /^session.*\.jsonl/
/** Staging subdirectory the previous fixture files are moved aside into. */
const PREVIOUS_DIR = '.previous'

function statOrUndefined(path) {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

/** The previous run's manifest, and only when this directory really holds one
 *  this script wrote (a parseable object carrying a `sessions` array). */
function readManifest(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.sessions)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Every fixture path the previous manifest recorded, ignoring any entry that
 *  would resolve outside the output root (a manifest must never aim the
 *  cleanup somewhere else). */
function manifestPaths(root, manifest) {
  const paths = []
  const push = value => {
    if (typeof value !== 'string' || value === '') return
    const absolute = resolve(value)
    const rel = relative(root, absolute)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return
    paths.push(absolute)
  }
  for (const session of manifest.sessions) {
    push(session?.compressedPath)
    push(session?.plainPath)
  }
  for (const value of Object.values(manifest.corruption ?? {})) push(value)
  return paths
}

/** Every file under `dir` shaped like this script's own output. A nested
 *  fixture root (a directory carrying its own manifest.json) is a tree of its
 *  own and is left alone, as is anything inside a `.git` store. */
function* ownedFixtureFiles(dir, isRoot = true) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  if (!isRoot && entries.some(entry => entry.isFile() && entry.name === 'manifest.json')) return
  for (const entry of entries) {
    if (entry.name === '.git') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* ownedFixtureFiles(path, false)
    else if (OWNED_FILE_NAME.test(entry.name)) yield path
  }
}

/** The exact set of files the regeneration replaces: the previous manifest's
 *  paths plus every file matching this script's shape. Sorted so that
 *  `manifest.json` goes LAST — it is cleared last and written first (see
 *  {@link land}), so an interrupted landing still leaves a directory this
 *  script recognizes as its own and recovers on the next run. */
function ownedFiles(root) {
  const manifestPath = join(root, 'manifest.json')
  const owned = new Set()
  const manifest = readManifest(root)
  if (manifest !== undefined) {
    owned.add(manifestPath)
    for (const path of manifestPaths(root, manifest)) owned.add(path)
  }
  for (const path of ownedFixtureFiles(root)) owned.add(path)
  const rank = path => (path === manifestPath ? 1 : 0)
  return [...owned].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))
}

/** The overwrite guard: never clear a directory this script cannot claim. */
function assertOverwritable(root, forcing) {
  const target = statOrUndefined(root)
  if (target === undefined) return
  if (!target.isDirectory()) {
    if (!forcing) {
      fail(
        `${root} exists and is not a directory; refusing to replace it`,
        `  pass --force to replace it with the generated fixture tree, or pick another output directory.`,
        `  目标已存在且不是目录，已拒绝覆盖；如需替换请加 --force。`,
      )
    }
    try {
      unlinkSync(root)
    } catch (error) {
      fail(`${root} is not a directory and could not be removed: ${error?.message ?? error}`)
    }
    return
  }
  if (resolve(root) === resolve(parse(root).root)) {
    fail(
      `refusing to use the filesystem root ${root} as the fixture output`,
      `  拒绝把文件系统根目录当作 fixture 输出目录。`,
    )
  }
  if (forcing) return
  const entries = readdirSync(root)
  if (entries.length === 0 || readManifest(root) !== undefined) return
  const listed = entries.slice(0, 5).join(', ')
  fail(
    `${root} is not empty and holds no manifest.json written by this script; refusing to overwrite it`,
    `  found: ${listed}${entries.length > 5 ? `, … (${entries.length} entries)` : ''}`,
    ...(entries.includes('manifest.json')
      ? ['  note: a manifest.json is present but is not one this script can read — a foreign file, or one locked by another process.']
      : []),
    `  use the default test/fixtures/generated, pass an empty (or missing) directory,`,
    `  or re-run with --force to overwrite it deliberately.`,
    `  该目录非空且不含本脚本写过的 manifest.json，已拒绝覆盖，未删除任何文件；`,
    `  请改用默认目录 / 空目录，或加 --force 显式强制覆盖。`,
  )
}

assertOverwritable(outRoot, force)

// The whole fixture set is generated into a sibling staging directory first,
// so a failure anywhere leaves the existing output directory untouched.
try {
  mkdirSync(dirname(outRoot), { recursive: true })
} catch (error) {
  fail(
    `cannot create the parent directory of ${outRoot}: ${error?.message ?? error}`,
    `  无法创建输出目录的父目录，未做任何改动。`,
  )
}
const stageRoot = `${outRoot}.tmp-${process.pid}-${Date.now().toString(36)}`
if (statOrUndefined(stageRoot) !== undefined) {
  fail(
    `staging directory ${stageRoot} already exists (left over from an interrupted run)`,
    `  remove it and re-run; ${outRoot} was left untouched.`,
  )
}
try {
  mkdirSync(stageRoot, { recursive: true, mode: 0o700 })
} catch (error) {
  fail(
    `cannot create the staging directory ${stageRoot}: ${error?.message ?? error}`,
    `  ${outRoot} was left untouched.`,
  )
}

/**
 * Write one generated file into the staging tree. Paths are built against
 * {@link outRoot} (the manifest records the final locations), so the staged
 * layout mirrors the final one exactly and landing is a pure rename.
 */
function writeLog(path, bytes) {
  const staged = join(stageRoot, relative(outRoot, path))
  mkdirSync(dirname(staged), { recursive: true, mode: 0o700 })
  writeFileSync(staged, bytes, { mode: 0o600 })
}

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

/** One conversation envelope. */
const env = (type, seq, data, extra = {}) =>
  JSON.stringify({ type, seq, time: 1_750_000_000_000 + seq * 1000, data, ...extra })

/** A header row + conversation, batched the way the backend flushes.
 *  `headerVersion` names the stored format generation the header declares;
 *  the real backend writes an `isSeeded` flag from v3 on. */
function conversation({ header, userTexts, assistantTexts, toolTexts = [], splicedFirst = undefined, legacyHeader = false, reasoningText = undefined, headerVersion = 0 }) {
  const batches = []
  batches.push([
    legacyHeader
      ? JSON.stringify({ version: 0, id: header.id, createdAt: header.createdAt, cwd: header.cwd })
      : JSON.stringify({
          type: 'session',
          version: headerVersion,
          id: header.id,
          createdAt: header.createdAt,
          cwd: header.cwd,
          ...(headerVersion >= 3 ? { isSeeded: false } : {}),
          delegationDepth: 0,
          agentPreset: 'standard',
        }),
  ])
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
    // Real harness logs put model reasoning in a `reasoning` block (earlier
    // shapes said `thinking`) ahead of the text blocks; one session carries
    // one so the indexThinking switch has something to chew on.
    const content =
      reasoningText === undefined
        ? [{ type: 'text', text }]
        : [{ type: 'reasoning', text: reasoningText }, { type: 'text', text }]
    events.push(env('assistant/message', seq, { turn: 1, step: seq, message: { role: 'assistant', content } }))
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
    reasoning: '先想清楚渠道抽象的边界，再决定注入点',
  },
  {
    // The legacy type-less header shape, pinned so tolerance for it survives.
    id: '33333333-3333-4333-8333-333333333333',
    workspace: 'd____repo-auth',
    cwd: 'D:/work/repo-auth/submodule',
    title: undefined,
    user: ['子目录会话：auth 子包的依赖怎么收敛'],
    assistant: ['用 workspace 协议收敛依赖'],
    tools: [],
    legacyHeader: true,
  },
]

// Generation-addressed stores (dsh-session-format's sessionFormatLogFilename):
// the current backend writes `session.vN.jsonl[.zstd]` instead of the v0
// `session.jsonl[.zstd]`, and a directory mid-migration can hold both — its
// reader picks the numerically highest generation, so the fixtures pin that
// the scanner sees new-generation sessions at all and never serves a retired
// generation's stale conversation. v4 is the generation the live 0.12.0 host
// writes; v3 stays as the retired one so a real v3 → v4 window is covered —
// on the real store that window is two COMPRESSED siblings.
const GENERATIONS = [
  {
    // The everyday new-generation session: v4, compressed — the shape a
    // current host actually writes.
    id: '77777777-7777-4777-8777-777777777777',
    workspace: 'd____repo-auth',
    cwd: 'D:/work/repo-auth',
    headerVersion: 4,
    compressedName: 'session.v4.jsonl.zstd',
    plainName: undefined,
    title: { title: 'v4 generation session', source: { kind: 'provider' } },
    user: ['新世代会话的日志名带 v4 后缀'],
    assistant: ['扫描器要按最高世代取用'],
    stale: [],
  },
  {
    // A migration window: the retired v0 AND v3 artifacts sit beside the
    // current v4 one, with different conversations. Only the v4 text may
    // enter the index. The retired v3 artifact is COMPRESSED here, matching
    // the live store: a v3 → v4 window holds `session.v3.jsonl.zstd` and
    // `session.v4.jsonl.zstd` in one directory (the v0 name predates the
    // suffix scheme, so it stays plain).
    id: '88888888-8888-4888-8888-888888888888',
    workspace: 'd____repo-auth',
    cwd: 'D:/work/repo-auth',
    headerVersion: 4,
    compressedName: 'session.v4.jsonl.zstd',
    plainName: undefined,
    title: { title: 'migrated session', source: { kind: 'provider' } },
    user: ['迁移后当前世代的正文'],
    assistant: ['v4 世代的内容'],
    stale: [
      {
        headerVersion: 3,
        logName: 'session.v3.jsonl.zstd',
        compressed: true,
        user: ['已退役 v3 世代的正文'],
        assistant: ['v3 世代的内容（不得被索引）'],
      },
      {
        headerVersion: 0,
        logName: 'session.jsonl',
        compressed: false,
        user: ['已退役 v0 世代的正文'],
        assistant: ['v0 世代的内容（不得被索引）'],
      },
    ],
  },
  {
    // Generation naming on the plaintext backend, still on the retired
    // generation: a store that has not migrated must keep enumerating.
    id: '99999999-9999-4999-8999-999999999999',
    workspace: 'd____repo-payments',
    cwd: 'D:/work/repo-payments',
    headerVersion: 3,
    compressedName: undefined,
    plainName: 'session.v3.jsonl',
    title: undefined,
    user: ['明文新世代会话也要枚举到'],
    assistant: ['plain v3'],
    stale: [],
  },
]

/**
 * Build the complete fixture set inside the staging directory and return its
 * manifest. Every path is computed against {@link outRoot} (the manifest must
 * point at the final locations) and every byte goes through {@link writeLog},
 * which redirects it into the staging tree.
 */
function generate() {
  const manifest = { root: outRoot, sessions: [], corruption: {} }

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
      legacyHeader: session.legacyHeader === true,
      reasoningText: session.reasoning,
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
      legacyHeader: session.legacyHeader === true,
      reasoningText: session.reasoning,
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

  for (const session of GENERATIONS) {
    const header = { id: session.id, createdAt: 1_750_000_000_000, cwd: session.cwd }
    const base = join(outRoot, session.workspace, session.id)
    const build = (texts, version, id) => {
      const batches = conversation({
        header: { ...header, id },
        userTexts: texts.user,
        assistantTexts: texts.assistant,
        headerVersion: version,
      })
      if (texts.title !== undefined) batches.push([env('session/title', 900, texts.title)])
      return batches
    }
    const current = build({ user: session.user, assistant: session.assistant, title: session.title }, session.headerVersion, session.id)
    const currentBytes = zstdChain(current)
    if (session.compressedName !== undefined) {
      writeLog(join(base, session.compressedName), currentBytes)
    } else {
      writeLog(join(base, session.plainName), Buffer.from(current.flat().map(line => line + '\n').join(''), 'utf8'))
    }
    for (const stale of session.stale) {
      const batches = build({ user: stale.user, assistant: stale.assistant, title: undefined }, stale.headerVersion, session.id)
      writeLog(
        join(base, stale.logName),
        stale.compressed
          ? zstdChain(batches)
          : Buffer.from(batches.flat().map(line => line + '\n').join(''), 'utf8'),
      )
    }
    manifest.sessions.push({
      id: session.id,
      plainId: undefined,
      compressedPath: session.compressedName === undefined ? undefined : join(base, session.compressedName),
      plainPath: session.plainName === undefined ? undefined : join(base, session.plainName),
      bytes: currentBytes.length,
      plainBytes: undefined,
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

  writeLog(join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

let manifest
try {
  manifest = generate()
} catch (error) {
  rmSync(stageRoot, { recursive: true, force: true })
  fail(
    `failed to generate the fixture set: ${error?.stack ?? error}`,
    `${outRoot} was left untouched.`,
    `  生成失败，输出目录未做任何改动。`,
  )
}

/** Every staged file, as a path relative to the staging root. */
function* stagedFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === PREVIOUS_DIR) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* stagedFiles(path)
    else yield relative(stageRoot, path)
  }
}

/** Move the fixture files that were moved aside back where they came from.
 *  Returns false when any of them could not be restored. */
function restoreFiles(moved) {
  let complete = true
  for (const [path, backup] of [...moved].reverse()) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      renameSync(backup, path)
    } catch (error) {
      complete = false
      console.error(`make-fixtures: could not move ${path} back into place: ${error?.message ?? error}`)
    }
  }
  return complete
}

/** Best-effort removal of files the failed landing had already placed. */
function removeFiles(paths) {
  for (const path of paths) {
    try {
      rmSync(path, { force: true })
    } catch (error) {
      console.error(`make-fixtures: could not remove ${path}: ${error?.message ?? error}`)
    }
  }
}

/** Remove directories the regeneration left empty (never the output root). */
function pruneEmptyDirs(dir, isRoot = true) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) pruneEmptyDirs(join(dir, entry.name), false)
  }
  if (isRoot) return
  try {
    rmdirSync(dir)
  } catch {
    // Not empty (an unrelated file, or a fixture that is still there) or held
    // open — either way it stays.
  }
}

/**
 * Land the staged set on {@link outRoot}. Old fixture files are moved aside
 * (not deleted) first, then the staged files are renamed in; any failure puts
 * the previous set back, so the target is never left half-regenerated.
 *
 * `manifest.json` is the commit point: it is cleared LAST in the move-aside
 * pass and written FIRST in the move-in pass. An interrupted landing (Ctrl+C,
 * a kill, a power cut) therefore still leaves a manifest behind, which is what
 * the overwrite guard above recognizes as this script's own directory — the
 * next run recovers by regenerating instead of refusing.
 */
function land() {
  const previousRoot = join(stageRoot, PREVIOUS_DIR)
  const owned = ownedFiles(outRoot)
  const moved = []
  for (const path of owned) {
    const backup = join(previousRoot, relative(outRoot, path))
    try {
      mkdirSync(dirname(backup), { recursive: true })
      renameSync(path, backup)
    } catch (error) {
      // A file that vanished between the listing and the rename (a concurrent
      // run of this script, say) is simply no longer there to clear.
      if (error?.code !== 'ENOENT') {
        const restored = restoreFiles(moved)
        rmSync(stageRoot, { recursive: true, force: true })
        fail(
          `cannot move the previous fixture file aside: ${path}`,
          `  ${error?.message ?? error}`,
          `  nothing was deleted: the previous fixture set in ${outRoot} is intact${restored ? '' : ' (some files could not be moved back — see above)'}.`,
          `  无法清理上一个 fixture 文件（可能被其他进程占用）；旧集合保持完整。`,
        )
      }
      continue
    }
    moved.push([path, backup])
  }

  const staged = [...stagedFiles(stageRoot)].sort((left, right) =>
    Number(right === 'manifest.json') - Number(left === 'manifest.json') || left.localeCompare(right),
  )
  const placed = []
  for (const rel of staged) {
    const to = join(outRoot, rel)
    try {
      mkdirSync(dirname(to), { recursive: true })
      renameSync(join(stageRoot, rel), to)
    } catch (error) {
      removeFiles(placed)
      const restored = restoreFiles(moved)
      pruneEmptyDirs(outRoot)
      rmSync(stageRoot, { recursive: true, force: true })
      fail(
        `cannot write ${to}`,
        `  ${error?.message ?? error}`,
        `  the previous fixture set was put back${restored ? '' : ' — some files could not be restored, see the lines above'}.`,
        `  写入失败：${to}；目标目录已恢复为上一个完整的 fixture 集。`,
      )
    }
    placed.push(to)
  }

  pruneEmptyDirs(outRoot)
  rmSync(stageRoot, { recursive: true, force: true })
  return placed.length
}

const files = land()
console.log(`fixtures written to ${outRoot}`)
console.log(`  files: ${files}`)
console.log(`  sessions: ${manifest.sessions.length} (v0 compressed + plain twins, v4 compressed, v3 plain, v0+v3(zstd)+v4 migration window)`)
console.log(`  corruption: torn frame, garbage, torn plain line`)
