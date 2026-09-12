/**
 * Dual-host verification matrix — run the plugin's build + test suite
 * against every supported dsh-tui host version in an isolated copy of the
 * workspace (the compatibility gate for the dual-version strategy; see
 * docs/decisions/2026-09-12-dual-version-compat-strategy.md).
 *
 * Why an isolated copy instead of swapping in place: the workspace tree
 * keeps a known-good node_modules (the `@deepseek-ai/dsh-commands` tree
 * cannot be installed outside the host monorepo, and a bad `workspace:*`
 * ref anywhere in the resolution tree poisons later `npm i` runs), so each
 * verification starts from that baseline rather than a fresh install.
 *
 * Why the host package is swapped with `npm install --no-save` instead of
 * extracting its tarball: the published tarball declares bundled dependencies
 * but ships none of their files, so a bare extraction leaves the host's own
 * imports (`react-reconciler`, …) unresolved. npm re-materializes those from
 * the registry; the tree keeps `--no-save` so the workspace baseline in
 * package.json is untouched. Should the install trip over a stray
 * `workspace:*` ref (the EUNSUPPORTEDPROTOCOL trap HANDOFF.md documents),
 * the script applies the documented recovery — drop the lockfile, patch
 * every package.json under node_modules — and retries once.
 *
 * Usage:
 *   node scripts/verify-host-matrix.mjs                 # both pinned hosts
 *   node scripts/verify-host-matrix.mjs --host 0.10.1   # one host
 *   node scripts/verify-host-matrix.mjs --keep          # keep the copies
 *
 * Exit code is non-zero if any host fails (pack, build or test); each
 * host's output streams through live.
 */

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const PACKAGE = '@deepseek-harness-tui/dsh-tui'
/** The compatibility matrix: the 0.9.3 build baseline and the 0.10.x line. */
const DEFAULT_HOSTS = ['0.9.3', '0.10.1']

function parseArgs(argv) {
  const hosts = []
  let keep = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') {
      if (argv[i + 1] === undefined) throw new Error('--host needs a version argument')
      hosts.push(argv[++i])
    } else if (argv[i] === '--keep') {
      keep = true
    } else {
      throw new Error(`unknown option: ${argv[i]}`)
    }
  }
  return { hosts: hosts.length > 0 ? hosts : DEFAULT_HOSTS, keep }
}

/** Spawn with live output; returns the exit code. npm/tar need a shell on Windows. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  return result.status ?? 1
}

/** Rewrite `"workspace:<range>"` refs to `"*"` in every package.json under
 *  `dir` (depth-first, all subdirectories), so the tree never carries the
 *  protocol npm cannot install outside the host monorepo. */
function patchWorkspaceRefs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) patchWorkspaceRefs(path)
    else if (entry.name === 'package.json') {
      const before = readFileSync(path, 'utf8')
      const after = before.replaceAll(/"workspace:([^"]*)"/g, '"*"')
      if (after !== before) writeFileSync(path, after)
    }
  }
}

const WORKSPACE = process.cwd()

/** Copy the workspace into `parent/repo`, leaving behind everything the
 *  verification does not need: git history, build output, generated
 *  fixtures (pretest regenerates them) and the packed tarballs. node_modules
 *  IS copied — it is the known-good dependency baseline the swap starts from. */
function makeCopy(parent) {
  const target = join(parent, 'repo')
  cpSync(WORKSPACE, target, {
    recursive: true,
    filter: source => {
      const relative = source.slice(WORKSPACE.length + 1)
      if (relative === '') return true
      if (relative === '.git' || relative === 'dist' || relative === '.rmtest-sessions' || relative === '.zcode') {
        return false
      }
      if (relative === join('test', 'fixtures', 'generated')) return false
      if (/^dsh-tui-find-.*\.tgz$/.test(relative)) return false
      return true
    },
  })
  return target
}

/** Download and extract the target host package's published tarball into
 *  `hostDir`, replacing whatever the copy's node_modules holds there. */
function extractTarball(version, hostDir) {
  const packDir = mkdtempSync(join(tmpdir(), `dsh-tui-find-pack-${version}-`))
  try {
    if (run('npm', ['pack', `"${PACKAGE}@${version}"`, '--pack-destination', '"."'], packDir) !== 0) {
      throw new Error(`npm pack ${PACKAGE}@${version} failed`)
    }
    const [tarball] = readdirSync(packDir).filter(name => name.endsWith('.tgz'))
    if (tarball === undefined) throw new Error(`npm pack produced no tarball for ${version}`)
    mkdirSync(join(packDir, 'x'))
    // Relative paths only: GNU tar reads a leading drive letter as a remote
    // host, so the extraction must run inside the pack directory.
    if (run('tar', ['-xzf', tarball, '-C', 'x'], packDir) !== 0) {
      throw new Error(`tar extract failed for ${version}`)
    }
    renameSync(join(packDir, 'x', 'package'), hostDir)
  } finally {
    rmSync(packDir, { recursive: true, force: true })
  }
}

/** Swap the copy's installed host package for the target version: extract
 *  its tarball, then materialize its declared runtime dependencies INSIDE
 *  the host package directory (the tarball ships only its bundled deps —
 *  `react-reconciler` and friends are declared but absent). The root tree
 *  is never reified: a root `npm install` prunes undeclared host-monorepo
 *  orphans (e.g. `@deepseek-ai/dsh-timeout`, imported by dsh-llm) that the
 *  workspace's known-good tree depends on, and cannot rebuild them outside
 *  the monorepo. Peer conflicts inside the host's own graph resolve the way
 *  the baseline tree was installed: legacy peer resolution. */
function swapHost(copyRoot, version) {
  const hostDir = join(copyRoot, 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
  rmSync(hostDir, { recursive: true, force: true })
  extractTarball(version, hostDir)
  patchWorkspaceRefs(hostDir)
  const innerInstall = () =>
    run(
      'npm',
      ['install', '--omit=dev', '--no-save', '--no-audit', '--no-fund', '--legacy-peer-deps', '--ignore-scripts'],
      hostDir,
    )
  let status = innerInstall()
  if (status !== 0) {
    rmSync(join(hostDir, 'package-lock.json'), { force: true })
    status = innerInstall()
  }
  if (status !== 0) throw new Error(`host dependency install failed for ${version}`)
  dedupeReactInstance(copyRoot, hostDir)
}

/** The inner install is isolated from the root tree, so it nests `react`
 *  even when the baseline tree dedupes it to the root copy — and two React
 *  instances break the injected hooks (dispatcher null). Drop the inner
 *  copy when the root's version satisfies the host's declared range; Node
 *  then resolves the host's import by walking up to the single root
 *  instance. Only caret/plain ranges are evaluated; anything exotic keeps
 *  the inner copy (fail-safe toward the known-good baseline layout). */
function dedupeReactInstance(copyRoot, hostDir) {
  const manifest = JSON.parse(readFileSync(join(hostDir, 'package.json'), 'utf8'))
  const range = manifest.dependencies?.['react']
  const inner = join(hostDir, 'node_modules', 'react')
  const rootManifest = join(copyRoot, 'node_modules', 'react', 'package.json')
  if (typeof range !== 'string' || !existsSync(inner) || !existsSync(rootManifest)) return
  const rootVersion = JSON.parse(readFileSync(rootManifest, 'utf8')).version ?? ''
  if (satisfiesCaret(rootVersion, range)) rmSync(inner, { recursive: true, force: true })
}

/** Minimal semver satisfaction for `^x.y.z` and exact `x.y.z` ranges. */
function satisfiesCaret(version, range) {
  const wanted = /^(\^)?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.exec(range.trim())
  const have = /^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.exec(version.trim())
  if (wanted === null || have === null) return false
  const [, caret, major, minor, patch] = wanted
  if (caret !== '^') return major === have[1] && minor === have[2] && patch === have[3]
  if (Number(major) !== Number(have[1])) return false
  if (Number(major) > 0) return true
  if (Number(minor) !== Number(have[2])) return false
  if (Number(minor) > 0) return true
  return Number(patch) === Number(have[3])
}

const { hosts, keep } = parseArgs(process.argv.slice(2))
const results = []
for (const version of hosts) {
  console.log(`\n=== dsh-tui ${version} ====================================`)
  const parent = mkdtempSync(join(tmpdir(), 'dsh-tui-find-matrix-'))
  try {
    const copyRoot = makeCopy(parent)
    swapHost(copyRoot, version)
    const status = run('npm', ['test'], copyRoot)
    results.push({ version, status })
  } catch (error) {
    console.error(`dsh-tui ${version}: ${error instanceof Error ? error.message : String(error)}`)
    results.push({ version, status: 1 })
  } finally {
    if (keep) console.log(`copy kept at ${parent}`)
    else rmSync(parent, { recursive: true, force: true })
  }
}

console.log('\n=== matrix summary ===')
for (const { version, status } of results) {
  console.log(`  dsh-tui ${version}: ${status === 0 ? 'PASS' : 'FAIL'}`)
}
if (results.some(result => result.status !== 0)) process.exitCode = 1
