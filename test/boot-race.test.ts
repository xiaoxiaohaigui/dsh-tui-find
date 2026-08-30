/**
 * Boot-race regression — reproduces the 0.1.5 startup breakage shape against
 * the REAL host adapter (TuiSceneRuntime from the published host package)
 * and the REAL plugin module, then requires the plugin to survive it.
 *
 * Mechanism: the host's fiber trust-table listeners are installed when the
 * TuiSceneRuntime service is constructed. In the forced interleaving below
 * the plugin fiber is created (and transitions to LOADING) BEFORE that
 * moment, while its apply runs AFTER the runtime's constructor — the exact
 * window in which every guarded seam call rejects with the host's unified
 * "requires a live Cordis activation context" error. The interleaving is
 * deterministic (no timers involved); the plugin's bounded retry then lands
 * the registration once its fiber's ACTIVE status event records it.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context, type Context as Ctx } from '@deepseek-ai/cordis'
import TuiSceneRuntime from '@deepseek-harness-tui/dsh-tui/scenes'
import plugin, { SCENE_ID } from '../dist/main.js'

const LIVENESS_FRAGMENT = 'requires a live Cordis activation context'

/** The plugin row as the host loader mounts it: module namespace with
 *  `inject` (Config omitted — cordis then skips row-config validation, same
 *  as the bare-harness mount tests; apply defaults the config itself). */
const pluginRow = { name: plugin.name, inject: plugin.inject, apply: plugin.apply }

/**
 * Duplicate-register probe. If the plugin's scene landed, the id is taken
 * and the host rejects with "already registered" before mutating anything;
 * if it did not, the probe takes the id and immediately releases it. Either
 * way the probe is side-effect free after the fact.
 */
function sceneRegistrationProbe(observed: string[]): { name: string, apply: (ctx: Ctx) => void } {
  return {
    name: 'dsh-tui-find-probe',
    apply: (ctx: Ctx) => {
      const scenes = ctx.get('tuiScenes', false)
      try {
        const dispose = scenes!.register({ id: SCENE_ID, title: 'probe', component: () => null }, ctx)
        dispose()
        observed.push('scene-absent')
      } catch (error) {
        observed.push((error as Error).message)
      }
    },
  }
}

describe('boot liveness race (real TuiSceneRuntime)', () => {
  it('recovers the scene registration when apply lands inside the boot window', async () => {
    const root = new Context()
    // Forced interleaving (all synchronous, deterministic):
    //  1. the plugin fiber is created while the runtime's listeners do not
    //     exist yet — its creation event is missed and it pends on `agents`;
    //  2. the runtime fiber's reload continuation queues first;
    //  3. the canary (no injects) goes LOADING now and queues behind it;
    //  4. providing `agents` on the always-ACTIVE root notifies waiting
    //     fibers synchronously — the plugin goes LOADING while the listeners
    //     still do not exist, and its reload queues last;
    //  5. the microtask drain then runs the runtime constructor (listeners
    //     installed) → canary apply (unretried register → rejected) → plugin
    //     apply (rejected once, retried onto the now-recorded fiber).
    const pluginFiber = root.plugin(pluginRow)
    const runtimeFiber = root.plugin(TuiSceneRuntime)
    const canaryObserved: string[] = []
    const canaryFiber = root.plugin({
      name: 'liveness-canary',
      apply: (ctx: Ctx) => {
        const scenes = ctx.get('tuiScenes', false)
        try {
          scenes!.register({ id: 'liveness-canary-scene', title: 'canary', component: () => null }, ctx)
          canaryObserved.push('canary-registered')
        } catch (error) {
          canaryObserved.push((error as Error).message)
        }
      },
    })
    root.reflect.provide('agents', {})

    // The plugin's activation must NOT fail — that is what took the 0.1.5
    // TUI boot down via the fail-closed plugin loader.
    const settled = await Promise.allSettled([pluginFiber, runtimeFiber, canaryFiber])
    expect(settled.map(s => s.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])

    // The canary pins the test to the actual race: a plain register in this
    // interleaving is rejected by the host's liveness gate. If the canary
    // ever passes, the forced window has collapsed and this test is no
    // longer exercising the failure it exists for.
    expect(canaryObserved[0]).toContain(LIVENESS_FRAGMENT)

    // The retried registration must land — poll with fresh probes so the
    // check survives scheduler jitter: the retry timer fires ~25 ms after
    // apply returned, and each probe either sees the id taken (done) or
    // takes-and-releases it synchronously (never stranding the retry).
    await vi.waitFor(
      async () => {
        const probeObserved: string[] = []
        await root.plugin(sceneRegistrationProbe(probeObserved))
        expect(probeObserved[0]).toContain('already registered')
      },
      { timeout: 5000, interval: 50 },
    )
  })

  it('keeps the synchronous registration path on a healthy interleaving', async () => {
    const root = new Context()
    root.reflect.provide('agents', {})
    // Runtime fully active (listeners installed) before the plugin fiber is
    // even created — the shape the loader produces when the plugin import
    // resolves after the TUI runtime applied. Registration must go through
    // on the first attempt, with the activation untouched.
    await root.plugin(TuiSceneRuntime)
    const pluginFiber = root.plugin(pluginRow)
    await expect(pluginFiber).resolves.toBeDefined()

    const probeObserved: string[] = []
    root.plugin(sceneRegistrationProbe(probeObserved))
    await vi.waitFor(() => expect(probeObserved.length).toBeGreaterThan(0), { timeout: 5000, interval: 10 })
    expect(probeObserved[0]).toContain('already registered')
  })
})
