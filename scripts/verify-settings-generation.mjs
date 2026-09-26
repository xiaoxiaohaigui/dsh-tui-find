/**
 * Verify the plugin against a real `@deepseek-ai/dsh-settings` install of the
 * ≥0.1.7 generation — the Config-derived forms the `/settings` screen reads.
 *
 * Why this exists: 0.1.7 removed the namespace-registration API entirely and
 * projects each profile entry's Cordis Config instead. A plugin that misses
 * the transition still boots, still registers its card, and simply renders
 * `命名空间未注册`; a card field whose Config key is not marked `.volatile()`
 * renders `（未设置）` forever. Both are silent, so they get a gate:
 * docs/decisions/2026-09-24-settings-generation-adaptation.md.
 *
 * What it checks (against the built `dist/`, not the sources):
 *   1. `volatileForm(Config)` is non-empty and holds exactly the live keys
 *      (the entry is listed by `describe()` only when it is);
 *   2. every live key is writable through the `isVolatilePath` gate;
 *   3. the card's field paths equal the live keys — the parity that keeps a
 *      field from rendering editable while nothing serves it;
 *   4. `projectForm` over a resolved row config yields a value for every
 *      defaulted knob, and an untouched optional text knob reads as unset;
 *   5. the wiring against a real-shaped service (no `register`, has
 *      `configure`): page policy opts out of the auto page on the plugin's own
 *      fiber, the initial value comes from the live config, and a
 *      `loader/volatile-update` re-read sees edited values.
 *
 * Usage:
 *   npm run build && node scripts/verify-settings-generation.mjs
 *   node scripts/verify-settings-generation.mjs --settings <dir>
 *   DSH_SETTINGS_DIR=<dir> node scripts/verify-settings-generation.mjs
 *
 * `<dir>` is a `@deepseek-ai/dsh-settings` package directory, e.g. the one a
 * real profile resolves:
 *   %USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh-settings
 *
 * Generation detection is behavioural, never a version parse: a legacy
 * install (≤0.1.6) is reported as "nothing to verify here" and exits 0 — its
 * path is covered by test/settings.test.ts. Exit code 1 on any failed check.
 *
 * The probe runs from a scratch directory inside the settings tree's own
 * `node_modules`, so the plugin's bare imports (`@deepseek-ai/schemastery`)
 * resolve exactly as they do at runtime there — the marking only happens on a
 * schemastery that knows `.volatile()` (3.18.3+), and that is the host's copy,
 * not this repo's. The directory is removed on the way out.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function parseArgs(argv) {
  let settings
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--settings') {
      if (argv[i + 1] === undefined) throw new Error('--settings needs a directory argument')
      settings = argv[++i]
    } else {
      throw new Error(`unknown option: ${argv[i]}`)
    }
  }
  return { settings }
}

/** Where the settings package lives: --settings, then DSH_SETTINGS_DIR, then
 *  this repo's own tree. */
function resolveSettingsDir(explicit) {
  const candidate =
    explicit ?? process.env['DSH_SETTINGS_DIR'] ?? join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-settings')
  if (!existsSync(join(candidate, 'package.json'))) {
    throw new Error(
      `no @deepseek-ai/dsh-settings at ${candidate}\n` +
        'pass --settings <dir> or set DSH_SETTINGS_DIR (a real profile resolves it under ' +
        '<DSH_HOME>/profiles/node_modules/@deepseek-ai/dsh-settings)',
    )
  }
  return candidate
}

const failures = []
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const { settings: explicitSettings } = parseArgs(process.argv.slice(2))
const settingsDir = resolveSettingsDir(explicitSettings)
const version = JSON.parse(readFileSync(join(settingsDir, 'package.json'), 'utf8')).version
console.log(`* @deepseek-ai/dsh-settings ${version} (${settingsDir})`)

const lib = await import(pathToFileURL(join(settingsDir, 'lib', 'index.js')).href)
const provider = lib.SettingsForms ?? lib.default
if (typeof provider?.prototype?.register === 'function') {
  console.log('* ≤0.1.6 generation (namespace registration): nothing to verify here.')
  console.log('  The plugin\'s legacy path is covered by test/settings.test.ts.')
  process.exit(0)
}
console.log('* ≥0.1.7 generation (Config-derived forms): verifying the plugin card against it.')

const distDir = join(repoRoot, 'dist')
if (!existsSync(join(distDir, 'config.js')) || !existsSync(join(distDir, 'settings.js'))) {
  throw new Error('dist/ is missing or stale — run `npm run build` first')
}

// Scratch dir inside the settings tree's node_modules: bare specifiers resolve
// from there exactly as the plugin's own copy would at runtime.
const probeRoot = join(dirname(dirname(settingsDir)), `.dsh-tui-find-settings-probe-${process.pid}`)
try {
  rmSync(probeRoot, { recursive: true, force: true })
  mkdirSync(probeRoot, { recursive: true })
  cpSync(distDir, join(probeRoot, 'dist'), { recursive: true })

  const plugin = name => import(pathToFileURL(join(probeRoot, 'dist', name)).href)
  const helper = name => import(pathToFileURL(join(settingsDir, 'lib', 'types', name)).href)

  const { Config, LIVE_CONFIG_KEYS, hasLiveConfigFields, readConfigValues, resolveConfig } = await plugin('config.js')
  const { registerSettingsSection, resolveSettingsNamespace, SETTINGS_NS } = await plugin('settings.js')
  const { volatileForm, projectForm, plainConfig, isVolatilePath } = await helper('schema.js')

  const liveKeys = [...LIVE_CONFIG_KEYS].sort()
  const form = volatileForm(Config)
  check('a live marker exists on the shipped Config', hasLiveConfigFields())
  check('volatileForm(Config) is non-empty (describe() lists the entry)', form !== undefined)
  const formKeys = Object.keys(form?.dict ?? {}).sort()
  check('live keys == form-projected keys', JSON.stringify(formKeys) === JSON.stringify(liveKeys), formKeys.join(', '))
  check('every live key passes the write gate', LIVE_CONFIG_KEYS.every(key => isVolatilePath(Config, [key])))

  // The namespace follows the Loader entry id on this generation (dsh-TUI
  // #990's fragility: the host keys by entry id, so a renamed row must move
  // the card with it) and falls back to the constant for an unusable id.
  const withEntry = id => ({ fiber: { entry: { options: { id } } } })
  check(
    'namespace follows the Loader entry id',
    resolveSettingsNamespace(withEntry('custom-find')) === 'custom-find',
    resolveSettingsNamespace(withEntry('custom-find')),
  )
  check(
    'namespace falls back for an unusable entry id',
    resolveSettingsNamespace(withEntry('Custom.TUI')) === SETTINGS_NS,
  )
  check('namespace defaults to the constant without a Loader entry', resolveSettingsNamespace({}) === SETTINGS_NS)

  const unset = projectForm(form, plainConfig(Config({})))
  const unsetMissing = LIVE_CONFIG_KEYS.filter(key => key !== 'sessionRoot' && unset[key] === undefined)
  check('defaulted knobs are always served (no （未设置）)', unsetMissing.length === 0, unsetMissing.join(', '))
  check('an untouched optional text knob reads as unset', unset.sessionRoot === undefined)

  const rowConfig = Config({ layout: 'classic', warmup: false, shortcut: 'ctrl+alt+g', sessionRoot: 'probe-root' })
  const view = projectForm(form, plainConfig(rowConfig))
  check(
    'user values survive the projection',
    view.layout === 'classic' && view.warmup === false && view.shortcut === 'ctrl+alt+g' && view.sessionRoot === 'probe-root',
    JSON.stringify(view),
  )

  const live = { current: rowConfig }
  const readRaw = () => readConfigValues(live.current)
  check('apply-time config resolves through live refs', resolveConfig(readRaw()).layout === 'classic')

  const configured = []
  const applied = []
  const cards = []
  let refresh
  const service = {
    configure: (presentation, owner) => {
      configured.push({ presentation, owner })
      return () => {}
    },
    describe: () => [],
    update: async () => {},
    mutate: async () => {},
  }
  const child = { settings: service, effect: factory => factory(), logger: { warn: () => {}, info: () => {} } }
  const ctx = {
    get: key =>
      key === 'tuiSettingsSections'
        ? {
            register: section => {
              cards.push(section)
              return () => {}
            },
          }
        : undefined,
    effect: factory => factory(),
    inject: (_deps, callback) => callback(child),
    on: (event, listener) => {
      check('listens on loader/volatile-update', event === 'loader/volatile-update', event)
      refresh = listener
      return () => {}
    },
    // The plugin's own fiber, as the Loader reports it: the namespace source.
    fiber: { entry: { options: { id: 'dsh-tui-find' } } },
    logger: child.logger,
  }
  registerSettingsSection(ctx, { resolved: resolveConfig(undefined), readRaw, onResolved: next => applied.push(next) })

  check('the card takes the Loader entry id as its namespace', cards[0]?.ns === 'dsh-tui-find', String(cards[0]?.ns))
  check('the default entry id equals the documented constant', SETTINGS_NS === 'dsh-tui-find', SETTINGS_NS)
  check('no namespace registration is attempted', typeof service.register === 'undefined')
  check(
    'page policy opts out of the auto page on the plugin fiber',
    configured.length === 1 && configured[0].presentation.auto === false && configured[0].owner === ctx.fiber,
  )
  const cardPaths = (cards[0]?.fields ?? []).map(field => field.path.join('.')).sort()
  check('card fields == live keys', JSON.stringify(cardPaths) === JSON.stringify(liveKeys), cardPaths.join(', '))
  check('initial value comes from the live config', applied.at(-1)?.layout === 'classic')

  const edited = Config({ layout: 'split', warmup: true, shortcut: 'off' })
  for (const [key, value] of Object.entries(edited)) live.current[key] = value
  refresh?.()
  check(
    'a volatile update re-reads the edited config',
    applied.at(-1)?.layout === 'split' && applied.at(-1)?.warmup === true && applied.at(-1)?.shortcut === undefined,
  )
} finally {
  rmSync(probeRoot, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
