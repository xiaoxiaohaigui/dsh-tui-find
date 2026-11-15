/**
 * Admission & mount tests — the plugin's own `/plugins check` equivalent,
 * headless (fake services, no model):
 *
 * 1. MANIFEST: the real dsh-plugin.json must parse and project under the
 *    SAME community-draft v0.15 parser the host admission pipeline uses
 *    (`@dsh-std/manifest`), with the contribution id `registerCommand` will
 *    demand and exactly the contracts the host offers the plugin.
 * 2. MOUNT: real cordis fibers mount the host plugin-host row plus the
 *    scenes/shortcuts/settings runtimes; the plugin's `apply` registers its
 *    scene and settings card into those live registries, degrades the
 *    mediated command registration to a contained warning (no commands
 *    service, no admitted identity in the bare harness), and stays healthy.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { parseManifest, projectManifest } from '@dsh-std/manifest'
import * as pluginHostRow from '@deepseek-harness-tui/dsh-tui/plugin-host'
import TuiSceneRuntime from '@deepseek-harness-tui/dsh-tui/scenes'
import TuiSettingsSectionsRuntime from '@deepseek-harness-tui/dsh-tui/settings-sections'
import plugin, {
  apply,
  COMMAND_CONTRIBUTION_ID,
  isExpectedAdmissionRejection,
  SCENE_ID,
} from '../dist/main.js'
import { getLang } from '../dist/i18n.js'
import type { TuiSettingsSectionsHost } from '@deepseek-harness-tui/dsh-tui/settings-sections'

/** The sidebar panel service arrived with 0.13.0; the dev baseline (0.9.3)
 *  does not export the subpath, so this leg skips the panel observation while
 *  the host matrix (0.13.0/0.17.0) runs it against the real service. */
const PANELS_SPECIFIER = '@deepseek-harness-tui/dsh-tui/panels'
const PANELS_PLUGIN = (
  await import(PANELS_SPECIFIER).catch(() => undefined)
)?.default as { name: string; apply: (ctx: Context) => void } | undefined
/** The host generation this leg compiles against, read from the installed
 *  package — the panel-service test below is about OUR assumption, not the
 *  host's: every supported leg (>= 0.13.0) must expose it. */
const HOST_VERSION = (
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json'), 'utf8')) as {
    version: string
  }
).version
const HOST_SUPPORTS_PANELS = (() => {
  const [major = 0, minor = 0] = HOST_VERSION.split('.').map(part => Number.parseInt(part, 10))
  return major > 0 || minor >= 13
})()

/** The composer `@` provider service arrived with 0.20.1; the dev baseline
 *  (0.9.3) does not export the subpath, so the observation below only runs on
 *  a matrix leg new enough to ship it. */
const MENTIONS_SPECIFIER = '@deepseek-harness-tui/dsh-tui/extensions'
const HOST_SUPPORTS_MENTIONS = (() => {
  const [major = 0, minor = 0] = HOST_VERSION.split('.').map(part => Number.parseInt(part, 10))
  return major > 0 || minor >= 20
})()
/** The service class, when this leg's package ships one. Resolved through the
 *  version gate rather than a catch alone: an older package exports neither the
 *  class nor the subpath, and a silent catch would hide a genuine import bug. */
/** The slice of `TuiMentionRuntime` the probe below drives. `register` is the
 *  only method plugins get; the duplicate-id refusal is the host's own
 *  admission answer, which is exactly what proves a provider landed. */
interface MentionSurfaceLike {
  register(provider: {
    id: string
    title: string
    complete(query: string, signal: AbortSignal): readonly never[]
  }): () => void
}

const MENTIONS_PLUGIN = HOST_SUPPORTS_MENTIONS
  ? ((await import(MENTIONS_SPECIFIER).catch(() => undefined)) as
      | { TuiMentionRuntime?: { name: string; apply: (ctx: Context) => void } }
      | undefined)?.TuiMentionRuntime
  : undefined
// These mounts activate the real plugin; keep the watermark journal off so
// no test ever writes against the real ~/.dsh-tui tree.
process.env['DSH_TUI_FIND_WATERMARK'] = 'off'

const MANIFEST_TEXT = readFileSync(join(import.meta.dirname, '..', 'dsh-plugin.json'), 'utf8')

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function mountHostRow(): Context {
  const root = new Context()
  root.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
  return root
}

describe('manifest admission', () => {
  it('parses under the community-draft v0.15 parser', () => {
    const manifest = parseManifest(MANIFEST_TEXT, { source: 'dsh-plugin.json' })
    expect(manifest.id).toBe('dsh-tui-find')
    expect(manifest.manifestVersion).toBe('0.15')
    expect(manifest.facets.host.entry).toBe('dist/main.js')
    expect(manifest.facets.host.apiVersion).toBe('v1alpha1')
  })

  it('projects the command contribution registerCommand will bind to', () => {
    const manifest = parseManifest(MANIFEST_TEXT, { source: 'dsh-plugin.json' })
    const projection = projectManifest(manifest)
    const hostFacet = projection.spec.facets.find(facet => facet.name === 'host')!
    const required = hostFacet.protocols.requires.map(c => `${c.apiVersion}#${c.kind}`)
    expect(required).toEqual(['commands.dsh/v1alpha1#Command'])
    // The mediated registration infers the contribution id from the
    // definition's bare name; the declared id must end with it.
    expect(COMMAND_CONTRIBUTION_ID.endsWith('.find')).toBe(true)
    expect(manifest.contributes.commands.map(c => c.id)).toEqual([COMMAND_CONTRIBUTION_ID])
  })

  it('requires exactly the contracts the plugin uses, no more', () => {
    const manifest = parseManifest(MANIFEST_TEXT, { source: 'dsh-plugin.json' })
    const coordinates = manifest.requires.contracts.map(c => `${c.apiVersion}#${c.kind}`)
    expect(coordinates).toEqual(['commands.dsh/v1alpha1#Command'])
    // Minimal permissions: v0.1 keeps the index in memory, requests nothing.
    expect(manifest.permissions).toEqual([])
    // No DecisionEvents — the plugin never intercepts anything.
    expect(coordinates.some(c => c.includes('DecisionEvents'))).toBe(false)
  })

  it('keeps the manifest version in lockstep with package.json', () => {
    // The 0.1.4 pack shipped a manifest still declaring 0.1.3 — the host
    // reads the manifest version, so drift here misreports the plugin.
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      version: string
    }
    const manifest = parseManifest(MANIFEST_TEXT, { source: 'dsh-plugin.json' })
    expect(manifest.version).toBe(pkg.version)
  })
})

/**
 * Wait for a cordis plugin row's asynchronous activation to have run (its
 * apply populates `observed`), polling instead of sleeping a fixed interval
 * so slow CI schedulers cannot flake the test.
 */
async function waitForActivation(observed: readonly string[]): Promise<void> {
  await vi.waitFor(
    () => {
      expect(observed.length).toBeGreaterThan(0)
    },
    { timeout: 5000, interval: 10 },
  )
}

describe('host packaging assumptions', () => {
  it('exposes the panel service exactly on the supported host generations', () => {
    // A silent skip on a supported leg would hide a removed export behind a
    // green matrix: the 0.13.0 floor and the release line must both carry it.
    expect(PANELS_PLUGIN !== undefined).toBe(HOST_SUPPORTS_PANELS)
  })
})

describe('mediated admission rejection classifier', () => {
  it('recognizes the host ComponentIdentityError shape and nothing else', () => {
    // The host internal carries the code OUTSIDE the message (name:
    // 'ComponentIdentityError', code: 'COMPONENT_NOT_ADMITTED'); the
    // classifier matches that shape structurally so the designed
    // C-070 fallback logs at info, and anything drifted or message-only
    // stays on the warn path.
    const shaped = Object.assign(
      new Error('the calling activation has no verified dsh-plugin.json Component identity'),
      { name: 'ComponentIdentityError', code: 'COMPONENT_NOT_ADMITTED' },
    )
    expect(isExpectedAdmissionRejection(shaped)).toBe(true)
    expect(isExpectedAdmissionRejection(new Error('COMPONENT_NOT_ADMITTED in message only'))).toBe(false)
    expect(
      isExpectedAdmissionRejection(
        Object.assign(new Error('drifted'), { name: 'ComponentIdentityError', code: 'SOMETHING_ELSE' }),
      ),
    ).toBe(false)
    expect(isExpectedAdmissionRejection('COMPONENT_NOT_ADMITTED')).toBe(false)
    expect(isExpectedAdmissionRejection(undefined)).toBe(false)
  })
})

describe('mount integration (headless harness)', () => {
  it('registers the scene and settings card into live host registries', async () => {
    const root = mountHostRow()
    // Cordis schedules plugin rows asynchronously — the sleeps only give
    // earlier rows a scheduler turn before the next row mounts (FIFO
    // activation order); the plugin's own completion is awaited by polling,
    // not by a fixed sleep.
    await sleep(30)
    root.plugin(TuiSceneRuntime)
    root.plugin(TuiSettingsSectionsRuntime)
    // Mount the real panel service too on hosts that ship one (0.13.0+): the
    // plugin's own register/whenSeamMounted path is then entered against the
    // host's actual validation and store, not the test suite's stand-in.
    if (PANELS_PLUGIN !== undefined) root.plugin(PANELS_PLUGIN)
    // The composer's @ provider service (0.20.1+): mounting the REAL runtime
    // puts the plugin's structural probe and its registration through the
    // host's own admission (id grammar, title cells, budget) instead of a
    // stand-in — the same reason the panel service is mounted above.
    if (MENTIONS_PLUGIN !== undefined) root.plugin(MENTIONS_PLUGIN)
    await sleep(30)
    // Every tui runtime method is caller- and liveness-checked through the
    // service proxy, so verification runs inside the plugin's own apply —
    // the same shape as a real host-side scene open. Observations are
    // collected, asserted outside the fiber.
    const observed: string[] = []
    root.plugin({
      name: plugin.name,
      apply: (ctx: Context) => {
        try {
          apply(ctx, {})
          const scenes = ctx.get('tuiScenes', false)
          observed.push(`open=${scenes!.open(SCENE_ID)}`)
          observed.push(`active=${scenes!.active?.id ?? 'none'}`)
          scenes!.close()
          observed.push(`afterClose=${scenes!.active?.id ?? 'none'}`)
          const sections = ctx.get('tuiSettingsSections', false) as TuiSettingsSectionsHost
          observed.push(`sections=${sections.list().map(s => s.ns).join(',')}`)
          // Read the subpages back out of the LIVE registry: the host's own
          // register() validates group ids and rejects a field naming an
          // undeclared one, so a card that lands here intact has had its
          // two-level split accepted by the host itself — not just by the
          // fake registry test/settings.test.ts drives (a rejection would cost
          // the whole card; see settings.ts's module doc).
          const card = sections.list().find(s => s.ns === 'dsh-tui-find')
          observed.push(`groups=${card?.groups?.map(group => group.id).join(',') ?? 'none'}`)
          // 0.17.0 validates the declared page at register time (id grammar +
          // trimmed non-empty title); a rejection throws out of register(), so
          // the card would be missing above — on that leg this reads back the
          // host-validated page. 0.13–0.16 register() just spreads the section
          // and their channel projection drops the key, so there this proves
          // "stored without throwing", not that the screen ignores it (that
          // half is the matrix leg's job: the old screens never read it).
          const page = (card as { page?: { id?: string } } | undefined)?.page
          observed.push(`page=${page?.id ?? 'none'}`)
          // The host-assigned panel id, from the host's own list. The panel is
          // accepted (or refused) inside the plugin activation just like the
          // scene registration above; a refusal would leave this empty.
          const panels = ctx.get('tuiPanels', false) as
            | { list(): Array<{ id: string; source?: string }> }
            | undefined
          observed.push(`panels=${panels?.list().map(panel => panel.id).join(',') ?? 'none'}`)
          // R-217: "the service is mounted" proves nothing about OUR
          // provider. Probe it the way the host itself would — a second
          // registration of the same id must be refused with the duplicate
          // error iff the plugin's provider actually landed.
          const mentions = ctx.get('tuiMentions', false) as MentionSurfaceLike | undefined
          if (MENTIONS_PLUGIN === undefined) observed.push('mentions=unsupported')
          else if (typeof mentions?.register !== 'function') observed.push('mentions=missing')
          else {
            try {
              const dispose = mentions.register({ id: 'dsh-tui-find', title: 'probe', complete: () => [] })
              dispose()
              observed.push('mentions=NOT-REGISTERED')
            } catch (error) {
              const text = error instanceof Error ? error.message : String(error)
              observed.push(`mentions=${text.includes('already registered') ? 'registered' : `error:${text}`}`)
            }
          }
        } catch (error) {
          observed.push(`error=${(error as Error).message}`)
        }
      },
    })
    await waitForActivation(observed)

    expect(observed).toContain('open=true')
    expect(observed).toContain(`active=${SCENE_ID}`)
    expect(observed).toContain('afterClose=none')
    expect(observed.some(o => o.startsWith('sections=') && o.includes('dsh-tui-find'))).toBe(true)
    expect(observed).toContain('groups=matching,indexing,advanced')
    expect(observed).toContain('page=dsh-tui-find')
    if (HOST_SUPPORTS_MENTIONS) {
      // R-217: the probe registers the SAME id the plugin uses and requires
      // the host's duplicate refusal — that fires only if the plugin's
      // provider is in the host's map. "The service exists" would pass even
      // with the plugin's registration deleted.
      expect(observed).toContain('mentions=registered')
    } else {
      // Older legs: the seam is genuinely absent, and the plugin must not have
      // invented one (the structural probe's no-op posture).
      expect(observed).toContain('mentions=unsupported')
    }
    if (PANELS_PLUGIN !== undefined) {
      // The descriptor cleared the host's own register() validation and the
      // host assigned the panel its prefixed id — the "panel missing" real-
      // machine check, now on every matrix run.
      const listed = observed.find(entry => entry.startsWith('panels=')) ?? ''
      expect(listed).not.toBe('panels=none')
      expect(listed.split('=')[1]?.split(',')).toContainEqual(expect.stringMatching(/:search$/u))
    }
  })

  it('stays healthy when the mediated command registration degrades', async () => {
    const root = mountHostRow()
    await sleep(30)
    root.plugin(TuiSceneRuntime)
    await sleep(30)
    const observed: string[] = []
    root.plugin({
      name: plugin.name,
      apply: (ctx: Context) => {
        try {
          // No commands service mounted: the mediated registration fails
          // loud inside the host; our apply contains it and the scene
          // registration still lands.
          apply(ctx, {})
          const scenes = ctx.get('tuiScenes', false)
          observed.push(`open=${scenes!.open(SCENE_ID)}`)
          scenes!.close()
        } catch (error) {
          observed.push(`error=${(error as Error).message}`)
        }
      },
    })
    await waitForActivation(observed)
    expect(observed).toContain('open=true')
  })

  it('reverts the language pin when the plugin deactivates', async () => {
    // The env var anchors the auto chain deterministically: after disposal
    // getLang() must fall back to it, proving the module-level pin did not
    // outlive the activation.
    const previous = process.env['DSH_TUI_LANG']
    process.env['DSH_TUI_LANG'] = 'zh'
    try {
      const root = new Context()
      const fiber = root.plugin({
        name: plugin.name,
        apply: (ctx: Context) => apply(ctx, { lang: 'en' }),
      })
      await sleep(30)
      expect(getLang()).toBe('en')
      await fiber.dispose()
      expect(getLang()).toBe('zh')
    } finally {
      if (previous === undefined) delete process.env['DSH_TUI_LANG']
      else process.env['DSH_TUI_LANG'] = previous
    }
  })
})
