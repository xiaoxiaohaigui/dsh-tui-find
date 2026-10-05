/**
 * The three user entries the plugin wires in its own `apply` (main.tsx):
 *
 * 1. COMMAND — `/find` on the host commands service (the direct C-070
 *    registration; the mediated plugin-host path is admission-tested in
 *    admission.test.ts), its raw-input seed, the reopen cycle that keeps a
 *    second `/find <words>` while the scene is up from being dropped, and the
 *    two degraded answers (no scenes seam, an open the host refuses).
 * 2. SHORTCUT — the handler the host invokes for the bound combo, with the
 *    guard that keeps a press from re-opening an already-open scene, the
 *    silent no-op on a composition without the scenes seam, and the unwinding
 *    of the binding with the activation.
 * 3. SCENE — the component handed to `tuiScenes.register`: the per-activation
 *    scanner/notifier/config it carries and the one-shot `/find <words>` seed
 *    it consumes. The last test mounts THAT component through the real host
 *    renderer (test/harness.ts), so the seed is asserted in the frame the user
 *    actually sees.
 *
 * The seams are faithful stubs on a real cordis Context: the subject is the
 * entry code in main.tsx, not the host runtimes (admission.test.ts mounts
 * those live; boot-race.test.ts owns the boot window). main.tsx's seed
 * (`pendingQuery`) is process-lifetime module state consumed exactly once, so
 * every test that sets it reads it back through the registered component.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReactElement } from 'react'
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Context as Ctx } from '@deepseek-ai/cordis'
import * as hostUi from '../node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ui.js'
import { DEFAULT_SHORTCUT, resolveConfig } from '../src/config.js'
import { SessionScanner } from '../src/core/scan.js'
import { dict } from '../src/i18n.js'
import { apply, inject, name, SCENE_ID } from '../src/main.js'
import { FindScene, type SceneSeed } from '../src/scene.js'
import { mount, mountKitComponent, panelKit, sessionWithMessages, waitFor, waitForMatch, type HarnessSceneProps } from './harness.js'

// These mounts activate the real plugin: keep the watermark journal off so no
// test ever writes against the real ~/.dsh-tui tree, and point the default
// root chain at an empty directory so the plugin's own scanner never sweeps
// the developer's real session library.
process.env['DSH_TUI_FIND_WATERMARK'] = 'off'
process.env['DSH_TUI_SESSION_ROOT'] = join(tmpdir(), 'dsh-tui-find-entry-wiring-empty')

/** One registered scene, as the host registry keeps it. The component is the
 *  plugin's own wrapper: called directly it returns the FindScene element the
 *  host would render, which is how the wiring below is read without a
 *  renderer. */
type SceneEntry = {
  id: string
  title: string
  component: (props: HarnessSceneProps) => ReactElement
}

/** The `/find` definition as the plugin registers it. */
type CommandEntry = {
  name: string
  description: string
  input: { hint: string }
  recordInput: boolean
  handler: (invocation: { rawInput: string }) => { kind: string; text?: string }
}

/** Stand-ins for the three seams the entries ride: registration records with
 *  activation-scoped disposers, the scenes registry's
 *  register/open/close/active contract (`open` answers false for an unknown
 *  id, and `failNextOpen` drives the host-refused case), and a shortcut
 *  registry that re-checks the combo like the host does (a live duplicate is
 *  refused with a no-op disposer, `list()` serves the registering caller). */
function stubSeams() {
  const scenes = new Map<string, SceneEntry>()
  const opened: string[] = []
  const closed: string[] = []
  const shortcuts: Array<{ combo: string; description: string; handler: () => void }> = []
  const commands: CommandEntry[] = []
  const panels: Array<{ id: string; title: string; component: unknown }> = []
  let active: { id: string } | undefined
  let failOpen = false
  // Real hosts resolve `ctx.get('tuiScenes')` through a liveness gate that
  // rejects reads made from async callbacks (the panel sweep's own supersede
  // probe runs there). `degradeActiveReads()` models that: from then on the
  // active getter throws, so the probe degrades to "no scene" exactly like the
  // documented real-host behavior.
  let activeReadsThrow = false
  return {
    opened,
    closed,
    shortcuts,
    commands,
    panels,
    degradeActiveReads: (): void => {
      activeReadsThrow = true
    },
    scene: (id: string): SceneEntry | undefined => scenes.get(id),
    /** Make the next open() answer false, as a host that refuses to mount. */
    failNextOpen: (): void => {
      failOpen = true
    },
    scenesService: {
      get active(): { id: string } | undefined {
        if (activeReadsThrow) throw new Error('dsh-tui: tuiScenes read rejected outside a live activation')
        return active
      },
      register(entry: SceneEntry): () => void {
        if (scenes.has(entry.id)) throw new Error(`TUI scene "${entry.id}" is already registered`)
        scenes.set(entry.id, entry)
        return () => {
          scenes.delete(entry.id)
        }
      },
      open(id: string): boolean {
        if (failOpen) {
          failOpen = false
          return false
        }
        if (!scenes.has(id)) return false
        active = { id }
        opened.push(id)
        return true
      },
      close(): void {
        if (active === undefined) return
        closed.push(active.id)
        active = undefined
      },
    },
    shortcutsService: {
      register(combo: string, definition: { description: string; handler: () => void }): () => void {
        if (shortcuts.some(entry => entry.combo === combo)) return () => {}
        const entry = { combo, description: definition.description, handler: definition.handler }
        shortcuts.push(entry)
        return () => {
          const at = shortcuts.indexOf(entry)
          if (at >= 0) shortcuts.splice(at, 1)
        }
      },
      list(): Array<{ combo: string; description: string }> {
        return shortcuts.map(({ combo, description }) => ({ combo, description }))
      },
    },
    commandsService: {
      register(definition: unknown): () => void {
        const entry = definition as CommandEntry
        commands.push(entry)
        return () => {
          const at = commands.indexOf(entry)
          if (at >= 0) commands.splice(at, 1)
        }
      },
    },
    /** The 0.13+ `tuiPanels` shape the plugin consumes: register keeps the
     *  descriptor, list answers with the host-assigned final ids, badge is
     *  recorded. */
    panelsService: {
      register(descriptor: { id: string; title: string; component: unknown }, _identity?: unknown): () => void {
        panels.push(descriptor)
        return () => {
          const at = panels.indexOf(descriptor)
          if (at >= 0) panels.splice(at, 1)
        }
      },
      list(): Array<{ id: string; title: string }> {
        return panels.map(descriptor => ({ id: `act1:${descriptor.id}`, title: descriptor.title }))
      },
      badge(): boolean {
        return true
      },
    },
  }
}

type Seams = ReturnType<typeof stubSeams>

/** Activations to unwind after each test (their disposers also clear the
 *  late-mount poll timers a missing seam would otherwise leave armed). */
const activations: Array<() => Promise<void>> = []

afterEach(async () => {
  while (activations.length > 0) await activations.pop()!()
})

/** Apply the real plugin against stub seams. `scenes: false` models a
 *  composition that has no TUI runtime at all — the entry that stays armed
 *  and silently does nothing. */
async function applyPlugin(
  options: {
    scenes?: boolean
    shortcuts?: boolean
    commands?: boolean
    panels?: boolean
    config?: Record<string, unknown>
  } = {},
): Promise<{ seams: Seams; fiber: { dispose(): Promise<void> } }> {
  const seams = stubSeams()
  const root = new Context()
  root.reflect.provide('agents', {})
  if (options.commands !== false) root.reflect.provide('commands', seams.commandsService)
  if (options.shortcuts !== false) root.reflect.provide('tuiShortcuts', seams.shortcutsService)
  if (options.scenes !== false) root.reflect.provide('tuiScenes', seams.scenesService)
  if (options.panels === true) root.reflect.provide('tuiPanels', seams.panelsService)
  // `lang` is pinned per activation so the entry copy the host renders is
  // deterministic; the scene assertions do not depend on it.
  const fiber = root.plugin({ name, inject, apply: (ctx: Ctx) => apply(ctx, { lang: 'en', ...options.config }) })
  await fiber
  activations.push(() => fiber.dispose())
  return { seams, fiber }
}

/** The one command the plugin registered on the stubbed commands service. */
function findCommand(seams: Seams): CommandEntry {
  expect(seams.commands).toHaveLength(1)
  return seams.commands[0]!
}

/** The scene element the registered wrapper produces. Only the four props the
 *  wrapper does not fill in itself are needed (React/ui/channel/close); config,
 *  scanner, notify and initialSeed come from the plugin. The cast mirrors the
 *  host boundary — the wrapper's contract is the element it returns, not the
 *  full prop bag a renderer hands it. */
function sceneElement(seams: Seams): ReactElement {
  const entry = seams.scene(SCENE_ID)
  if (entry === undefined) throw new Error('the plugin registered no scene')
  return entry.component({ React, ui: hostUi, channel: {}, close: () => {} } as unknown as HarnessSceneProps)
}

/** The seed the scene will read on mount, taken exactly as FindScene takes it
 *  (`useState(() => props.initialSeed?.())`). The plugin's wrapper always
 *  returns a seed — a spent/absent one is `{ query: '' }`, never a fall-through
 *  to some other caller's query. */
function readSeed(seams: Seams): SceneSeed {
  return (sceneElement(seams).props as { initialSeed: () => SceneSeed }).initialSeed()
}

describe('/find command entry', () => {
  it('registers the definition on the commands service and opens the scene on invocation', async () => {
    const { seams } = await applyPlugin()
    const command = findCommand(seams)

    expect(command.name).toBe('find')
    expect(command.description).toBe(dict['cmd-desc-find'].en)
    expect(command.input.hint).toBe('<keywords>')
    // The query is UI state, not conversation content: it stays out of the log.
    expect(command.recordInput).toBe(false)

    expect(command.handler({ rawInput: '  needle two  ' })).toEqual({ kind: 'success' })
    expect(seams.opened).toEqual([SCENE_ID])
  })

  it('cycles the scene so a second /find while it is open is not dropped', async () => {
    const { seams } = await applyPlugin()
    const command = findCommand(seams)

    command.handler({ rawInput: 'first' })
    // An already-open scene does not remount on re-open, so the second
    // invocation must close it first — otherwise the new words never reach the
    // scene and are silently lost.
    command.handler({ rawInput: 'second words' })

    expect(seams.opened).toEqual([SCENE_ID, SCENE_ID])
    expect(seams.closed).toEqual([SCENE_ID])
    expect(readSeed(seams)).toEqual({ query: 'second words' })
    expect(readSeed(seams)).toEqual({ query: '' })
  })

  it('answers the designed error when the composition has no scenes seam', async () => {
    const { seams } = await applyPlugin({ scenes: false })
    // The command still registers — the entry exists and reports why it
    // cannot open, instead of being absent from the palette.
    const command = findCommand(seams)

    expect(command.handler({ rawInput: 'needle' })).toEqual({
      kind: 'error',
      text: 'dsh-tui-find: TUI scenes seam unavailable',
    })
    expect(seams.opened).toEqual([])
  })

  it('answers an error and drops the seed when the host refuses to open', async () => {
    const { seams } = await applyPlugin()
    const command = findCommand(seams)

    seams.failNextOpen()
    expect(command.handler({ rawInput: 'leaked words' })).toEqual({
      kind: 'error',
      text: 'dsh-tui-find: failed to open the find scene',
    })
    // A failed open leaves no scene to consume the seed: keeping it would leak
    // these words into the NEXT scene, whichever entry opens it.
    expect(readSeed(seams)).toEqual({ query: '' })
  })
})

describe('global shortcut entry', () => {
  it('opens the scene from the bound handler and no-ops while it is already up', async () => {
    const { seams, fiber } = await applyPlugin()
    expect(seams.shortcuts).toHaveLength(1)
    const binding = seams.shortcuts[0]!
    expect(binding.combo).toBe(DEFAULT_SHORTCUT)
    expect(binding.description).toBe(dict['shortcut-desc-find'].en)

    binding.handler()
    expect(seams.opened).toEqual([SCENE_ID])
    // The shortcut toggles nothing: a second press while the scene holds the
    // screen must not open it again (that would remount and lose the query).
    binding.handler()
    expect(seams.opened).toEqual([SCENE_ID])

    // The binding is scoped to the activation: deactivating the plugin row
    // must leave no combo behind for the whole session.
    await fiber.dispose()
    expect(seams.shortcuts).toEqual([])
  })

  it('stays a silent no-op when the composition has no scenes seam', async () => {
    const { seams } = await applyPlugin({ scenes: false })
    expect(seams.shortcuts).toHaveLength(1)

    expect(() => seams.shortcuts[0]!.handler()).not.toThrow()
    expect(seams.opened).toEqual([])
  })
})

describe('sidebar panel wiring', () => {
  it('never registers the panel when the panel row is off', async () => {
    // R-128: the host re-appends a plugin panel to its enable list on every
    // registration, so "off" has to mean never registered — not registered
    // and then removed.
    const { seams } = await applyPlugin({ panels: true, config: { panel: false } })
    expect(seams.panels).toEqual([])
  })

  /** A session root holding ONE large plain session log, so the panel's own
   *  sweep is still decoding when the command lands (an empty root settles
   *  before the test can act — the sweep has to be in flight for the
   *  stand-down to be observable at all). */
  function bulkSessionRoot(): string {
    const root = join(tmpdir(), 'dsh-tui-find-panel-bulk')
    const dir = join(root, 'workspace', 'bulk-session')
    mkdirSync(dir, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session', version: 0, id: 'bulk', createdAt: Date.now(), cwd: process.cwd() }),
    ]
    for (let seq = 1; seq <= 40_000; seq++) {
      lines.push(
        JSON.stringify({
          type: 'user/message',
          seq,
          time: Date.now(),
          data: { content: [{ type: 'text', text: `needle row ${seq}` }], source: { kind: 'user' } },
        }),
      )
    }
    writeFileSync(join(dir, 'session.jsonl'), lines.join('\n'))
    return root
  }

  it('registers the panel and makes its sweep stand down when /find opens the scene', async () => {
    const sessionRoot = bulkSessionRoot()
    const { seams } = await applyPlugin({ panels: true, config: { sessionRoot } })
    const panel = seams.panels[0]
    expect(panel).toBeDefined()
    expect(panel!.id).toBe('search')

    // Mount the component the host would: a panel-sized kit, a stub host API.
    const listeners = new Set<() => void>()
    const Component = panel!.component as React.ComponentType<Record<string, unknown>>
    const view = await mountKitComponent(
      React.createElement(Component, {
        React,
        ui: panelKit(40, 16),
        host: {
          snapshot: () => ({ sessionId: 'session', cwd: process.cwd() }),
          onKey: (listener: () => void) => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
        },
        width: 40,
        height: 16,
        focused: true,
        visible: true,
        mode: 'split',
      }),
      { columns: 40, rows: 16, settle: false },
    )
    try {
      // The mount effect started the plugin's own sweep and nothing has
      // resolved yet, so this is the state that matters: the scene must take
      // over from a sweep still in flight (review F3 — before the fix the
      // shared scene opener told this driver nothing, and two sweeps decoded
      // the same library).
      expect(findCommand(seams).handler({ rawInput: '' })).toEqual({ kind: 'success' })
      expect(seams.opened).toEqual([SCENE_ID])
      // From here the driver's own scene probe is unreliable (see the stub) —
      // the stand-down has to have come from the shared scene opener.
      seams.degradeActiveReads()

      // The panel stood down: nothing ticks again, so no frame ever shows the
      // sweep running or its settled result. (The first frame after the
      // command is still the pre-abort paint; give the repaint a beat, then
      // sample for a second.) Without the scene-open handoff the panel would
      // keep decoding behind the scene and land on the settled "no searchable
      // session content".
      await waitFor(100)
      const deadline = Date.now() + 1_000
      while (Date.now() < deadline) {
        expect(view.latest()).not.toMatch(/Scanning/)
        expect(view.latest()).not.toMatch(/No\s*searchable/)
        await waitFor(50)
      }
      expect(view.latest()).toMatch(/Reading\s*sessions/)
    } finally {
      view.unmount()
    }
  })
})

describe('registered scene component', () => {
  it('wraps FindScene with the activation scanner, notifier and resolved config', async () => {
    const first = await applyPlugin()
    const second = await applyPlugin()
    const element = sceneElement(first.seams)
    const props = element.props as {
      config: unknown
      scanner: unknown
      notify: unknown
      initialSeed: () => SceneSeed | undefined
    }

    expect(element.type).toBe(FindScene)
    // One scanner per ACTIVATION (scan.ts's lifecycle contract): its decode
    // cache outlives scene close/open, so every activation carries its own.
    expect(props.scanner).toBeInstanceOf(SessionScanner)
    expect(props.scanner).not.toBe((sceneElement(second.seams).props as { scanner: unknown }).scanner)
    expect(typeof props.notify).toBe('function')
    expect(props.config).toEqual(resolveConfig({ lang: 'en' }))
    expect(typeof props.initialSeed).toBe('function')
  })

  it('consumes the /find seed exactly once', async () => {
    const { seams } = await applyPlugin()
    findCommand(seams).handler({ rawInput: '  needle two  ' })

    // Process-lifetime module state: the first mount reads the words (the
    // command's own handler trims them), and no later mount sees them again.
    expect(readSeed(seams)).toEqual({ query: 'needle two' })
    expect(readSeed(seams)).toEqual({ query: '' })
  })

  it('renders the seeded query through the real host renderer, once', async () => {
    const { seams } = await applyPlugin()
    findCommand(seams).handler({ rawInput: 'needle two' })
    const { component } = seams.scene(SCENE_ID)!

    const seeded = await mount(sessionWithMessages(['body']), { component })
    try {
      seeded.resize(81, 12)
      await waitFor()
      // The frame collapses glyph cells, so the words are matched with `\s*`
      // (the same reason every frame assertion in scene.test.ts does).
      expect(seeded.latest()).toMatch(/⌕\s*needle\s*two/)
    } finally {
      seeded.dispose()
    }

    // The same registered component on the next mount: the seed was spent by
    // the first one, so the query bar comes up on its placeholder.
    const spent = await mount(sessionWithMessages(['body']), { component })
    try {
      spent.resize(81, 12)
      await waitFor()
      expect(spent.latest()).not.toMatch(/needle\s*two/)
      expect(spent.latest()).toMatch(/Type\s*to\s*search/)
    } finally {
      spent.dispose()
    }
  })
})
