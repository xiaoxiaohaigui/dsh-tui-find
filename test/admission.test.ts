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
