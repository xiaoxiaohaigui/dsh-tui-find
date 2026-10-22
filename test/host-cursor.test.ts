/**
 * `src/vendor/host-cursor.ts`: which hook the bridge calls, and what it lets a
 * caller paint.
 *
 * The contract has three clauses, and every one of them is a compatibility
 * decision rather than an implementation detail:
 *
 * 1. the PUBLIC ui hooks win when the kit carries them (0.15.0+ exported
 *    `useDeclaredCursor`/`useNativeCursor` from the kit a scene receives) —
 *    the vendored file path is a fallback, not the route;
 * 2. a kit with only half the pair is not half-used: both hooks come from one
 *    export line in every real host, and mixing the two would change the hook
 *    count mid-lifetime;
 * 3. `visible` is the caller's INTENT, never a promise: the bridge narrows it
 *    with `useNativeCursor()`, so an old host or a static renderer keeps its
 *    painted caret.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { describe, expect, it } from 'vitest'
import * as hostUi from '../node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ui.js'
import {
  useHostCursor,
  type HostCursor,
  type HostCursorKit,
  type HostCursorOptions,
} from '../src/vendor/host-cursor.js'
import { mountKitComponent } from './harness.js'

/** The fallback module, loaded exactly the way the bridge loads it — so the
 *  assertions below can name what the installed host generation provides. */
function loadVendoredHooks(): HostCursorKit {
  try {
    const entryUrl = import.meta.resolve('@deepseek-harness-tui/dsh-tui')
    const root = fileURLToPath(entryUrl).replace(/[\\/]lib[\\/]types[\\/].*$/, '')
    const mod = createRequire(import.meta.url)(`${root}/lib/types/ink/hooks/use-declared-cursor.js`) as HostCursorKit
    return typeof mod.useDeclaredCursor === 'function' ? mod : {}
  } catch {
    return {}
  }
}

const vendored = loadVendoredHooks()
/** 0.15.0+ exposes the native flag; the 0.9.3/0.13.0/0.14.x file does not. */
const vendoredHasNative = typeof vendored.useNativeCursor === 'function'

/** Render the bridge once inside the real host renderer and answer what it
 *  returned. The harness's kit mount is the same fake TTY the scene gets, so
 *  `useNativeCursor()` sees what it would see in an /find session. */
async function probe(kit: HostCursorKit | undefined, options: HostCursorOptions): Promise<HostCursor> {
  const captured: { result?: HostCursor } = {}
  const Probe = (): React.ReactElement => {
    captured.result = useHostCursor(kit, options)
    return React.createElement(hostUi.Text, null, 'probe')
  }
  const view = await mountKitComponent(React.createElement(Probe), { columns: 20, rows: 4 })
  view.unmount()
  if (captured.result === undefined) throw new Error('the probe never rendered')
  return captured.result
}

/** A recording stand-in for the public pair. */
function publicKit(native: boolean): { kit: HostCursorKit; calls: HostCursorOptions[]; refs: HostCursorRefLike[] } {
  const calls: HostCursorOptions[] = []
  const refs: HostCursorRefLike[] = []
  return {
    calls,
    refs,
    kit: {
      useDeclaredCursor: options => {
        calls.push(options)
        const ref = (): void => {}
        refs.push(ref)
        return ref
      },
      useNativeCursor: () => native,
    },
  }
}

type HostCursorRefLike = (node: object | null) => void

describe('host cursor bridge', () => {
  it('prefers the public ui hooks and passes the caret intent through', async () => {
    const { kit, calls, refs } = publicKit(true)
    const result = await probe(kit, { line: 2, column: 5, active: true, visible: true })
    expect(result.native).toBe(true)
    expect(result.ref).toBe(refs.at(-1))
    expect(calls.at(-1)).toEqual({ line: 2, column: 5, active: true, visible: true })
  })

  it('never asks for a visible caret where the renderer has none', async () => {
    const { kit, calls } = publicKit(false)
    const result = await probe(kit, { line: 1, column: 4, active: true, visible: true })
    expect(result.native).toBe(false)
    // The intent says "this box owns the keyboard"; the renderer says it
    // cannot draw a caret — the painted block is what the caller keeps.
    expect(calls.at(-1)).toMatchObject({ line: 1, column: 4, active: true, visible: false })
  })

  it('stays hidden when the surface does not own the keyboard', async () => {
    const { kit, calls } = publicKit(true)
    const result = await probe(kit, { line: 1, column: 4, active: true })
    expect(result.native).toBe(true)
    expect(calls.at(-1)).toMatchObject({ active: true, visible: false })
  })

  it('ignores a kit that carries only half the pair', async () => {
    const calls: HostCursorOptions[] = []
    const half: HostCursorKit = {
      useDeclaredCursor: options => {
        calls.push(options)
        return () => {}
      },
    }
    const result = await probe(half, { line: 1, column: 4, active: false })
    expect(calls).toEqual([])
    expect(result.ref === undefined).toBe(vendored.useDeclaredCursor === undefined)
    expect(result.native).toBe(vendoredHasNative)
  })

  it('degrades to the vendored hook module when the kit has none', async () => {
    const result = await probe(undefined, { line: 1, column: 4, active: true, visible: true })
    expect(result.ref === undefined).toBe(vendored.useDeclaredCursor === undefined)
    // The fallback reports the same native flag its own module exposes — the
    // panel has no other way to learn it (its kit carries no hooks).
    expect(result.native).toBe(vendoredHasNative)
  })
})
