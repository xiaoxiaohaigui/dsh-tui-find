/**
 * The sidebar panel's seam wiring (src/panel.tsx, registerFindPanel): the
 * structural soft probe on `ctx.tuiPanels` (0.13.0+ only — the sidebar itself
 * arrived in that release), the descriptor the host validates, and the two
 * failure shapes the other seams handle the same way (an absent service is a
 * silent no-op; a boot-window refusal is retried on the shared budget).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context as Ctx } from '@deepseek-ai/cordis'
import { setLangOverride, t } from '../src/i18n.js'
import {
  PANEL_API_VERSION,
  PANEL_ICON,
  PANEL_ID,
  PANEL_MIN_COLUMNS,
  PANEL_ORDER,
  PANEL_TITLE_KEY,
  FindPanelRegistration,
  registerFindPanel,
  type FindPanelProps,
} from '../src/panel.js'
import type { FindPanelDriver } from '../src/panel-model.js'
import { REGISTER_RETRY_DELAY_MS, SEAM_MOUNT_DELAY_MS, SEAM_TOTAL_BUDGET_MS } from '../src/seam.js'

/** Minimal activation-context stand-in: warn/info capture, effect collection
 *  and a MUTABLE string-keyed service map (the late-mount tests install a
 *  service after the poll started). */
function stubCtx(services: Record<string, unknown> = {}) {
  const warns: string[] = []
  const infos: string[] = []
  const disposers: Array<() => void> = []
  const map: Record<string, unknown> = { ...services }
  const ctx = {
    logger: {
      warn: (message: string) => {
        warns.push(message)
      },
      info: (message: string) => {
        infos.push(message)
      },
    },
    effect: (callback: () => () => void) => {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
    get: (name: string) => map[name],
  } as unknown as Ctx
  return {
    ctx,
    warns,
    infos,
    disposers,
    provide(name: string, value: unknown) {
      map[name] = value
    },
  }
}

interface PanelDescriptor {
  apiVersion: number
  id: string
  title: string
  icon?: string
  minColumns?: number
  order?: number
  component: React.ComponentType<FindPanelProps>
}

/** A 0.13-shaped tuiPanels stand-in: register keeps the descriptor plus the
 *  identity argument and hands back a real disposer; `list` answers with the
 *  FINAL ids the host assigns (the plugin's own id is only the suffix), and
 *  `badge` records what the driver asks for. */
function stubPanels() {
  const descriptors: PanelDescriptor[] = []
  const identities: unknown[] = []
  const badges: Array<{ id: string; badge: unknown }> = []
  const runtime = {
    register: vi.fn((descriptor: PanelDescriptor, identity?: unknown) => {
      descriptors.push(descriptor)
      identities.push(identity)
      return () => {
        const at = descriptors.indexOf(descriptor)
        if (at >= 0) descriptors.splice(at, 1)
      }
    }),
    list: vi.fn(() => descriptors.map(descriptor => ({ id: `act1:${descriptor.id}`, title: descriptor.title }))),
    badge: vi.fn((id: string, badge: unknown) => {
      badges.push({ id, badge })
      return true
    }),
  }
  return { runtime, descriptors, identities, badges, register: runtime.register, badge: runtime.badge }
}

const DRIVER = { bindBadge: vi.fn() } as unknown as FindPanelDriver

beforeEach(() => {
  setLangOverride(undefined)
})

afterEach(() => {
  setLangOverride(undefined)
  vi.useRealTimers()
})

describe('registerFindPanel', () => {
  it('registers the descriptor the host validates, scoped to the activation', () => {
    const panels = stubPanels()
    const { ctx, disposers } = stubCtx({ tuiPanels: panels.runtime })
    registerFindPanel(ctx, { driver: DRIVER })

    expect(panels.register).toHaveBeenCalledTimes(1)
    const descriptor = panels.descriptors[0]!
    // The host rejects any other apiVersion outright, prefixes the id with the
    // plugin id, and measures the icon with its own stringWidth — a 2-cell
    // glyph would be refused and the panel would silently never appear.
    expect(descriptor.apiVersion).toBe(PANEL_API_VERSION)
    expect(descriptor.id).toBe(PANEL_ID)
    expect(descriptor.id).toMatch(/^[a-z][a-z0-9_-]*$/)
    expect(descriptor.icon).toBe(PANEL_ICON)
    expect(descriptor.minColumns).toBe(PANEL_MIN_COLUMNS)
    expect(descriptor.order).toBe(PANEL_ORDER)
    expect(typeof descriptor.component).toBe('function')
    // The activation context is the identity the host checks ownership with.
    expect(panels.identities[0]).toBe(ctx)
    // The registration's disposer rides the activation's effect ledger.
    expect(disposers).toHaveLength(1)
    disposers[0]!()
    expect(panels.descriptors).toEqual([])
  })

  it('localizes the tab title at registration time', () => {
    setLangOverride('en')
    const panels = stubPanels()
    registerFindPanel(stubCtx({ tuiPanels: panels.runtime }).ctx, { driver: DRIVER })
    expect(panels.descriptors[0]!.title).toBe(t(PANEL_TITLE_KEY))
    expect(panels.descriptors[0]!.title).toBe('Search')

    setLangOverride('zh')
    const zh = stubPanels()
    registerFindPanel(stubCtx({ tuiPanels: zh.runtime }).ctx, { driver: DRIVER })
    expect(zh.descriptors[0]!.title).toBe('搜索')
  })

  it('is a silent no-op on a host without the seam (0.9.x – 0.12.x)', () => {
    vi.useFakeTimers()
    const toast = { show: vi.fn() }
    const { ctx, warns, disposers } = stubCtx({ tuiToast: toast })
    expect(() => registerFindPanel(ctx, { driver: DRIVER })).not.toThrow()
    expect(warns).toEqual([])
    // The service is absent for the whole budget (the designed state before
    // 0.13.0): nothing registers, nothing is warned, and — unlike the other
    // seams — the give-up announcement is silenced, so no toast ever tells a
    // 0.12 user about a sidebar they do not have.
    vi.advanceTimersByTime(SEAM_TOTAL_BUDGET_MS)
    expect(warns).toEqual([])
    expect(toast.show).not.toHaveBeenCalled()
    // The poll timer rides the activation: disposing the effect stops it.
    expect(disposers).toHaveLength(1)
    disposers[0]!()
  })

  it('registers late when the service mounts after apply', () => {
    vi.useFakeTimers()
    const panels = stubPanels()
    const { ctx, provide } = stubCtx({})
    registerFindPanel(ctx, { driver: DRIVER })
    expect(panels.register).not.toHaveBeenCalled()

    // The TUI's service rows mount independently of this plugin's row; a miss
    // at apply time must not cost the panel for the whole session.
    provide('tuiPanels', panels.runtime)
    vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS)
    expect(panels.register).toHaveBeenCalledTimes(1)
    expect(panels.descriptors[0]!.id).toBe(PANEL_ID)
  })

  it('is a no-op on a drifted service without a register member', () => {
    vi.useFakeTimers()
    const { ctx, warns, infos } = stubCtx({ tuiPanels: { list: () => [] } })
    registerFindPanel(ctx, { driver: DRIVER })
    expect(warns).toEqual([])
    // A register-less service is not the seam: keep polling (a later, real
    // mount could still land) but never call into the drifted shape.
    vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS * 3)
    expect(warns).toEqual([])
    expect(infos).toEqual([])
  })

  it('retries a boot-window refusal and lands the panel once the gate opens', () => {
    vi.useFakeTimers()
    const panels = stubPanels()
    let landed = false
    panels.register.mockImplementation((descriptor: PanelDescriptor, identity?: unknown) => {
      void descriptor
      void identity
      if (panels.register.mock.calls.length <= 2) return undefined
      landed = true
      return () => {
        landed = false
      }
    })
    const { ctx, warns } = stubCtx({ tuiPanels: panels.runtime })
    registerFindPanel(ctx, { driver: DRIVER })

    expect(panels.register).toHaveBeenCalledTimes(1)
    expect(landed).toBe(false)
    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS * 2)
    expect(panels.register).toHaveBeenCalledTimes(3)
    expect(landed).toBe(true)
    expect(warns).toEqual([expect.stringContaining('registered on retry')])
  })

  it('retries a throwing registration the same way', () => {
    vi.useFakeTimers()
    const panels = stubPanels()
    panels.register.mockImplementationOnce(() => {
      throw new Error('tuiPanels.register requires a live non-root plugin activation')
    })
    const { ctx, warns } = stubCtx({ tuiPanels: panels.runtime })
    registerFindPanel(ctx, { driver: DRIVER })

    vi.advanceTimersByTime(REGISTER_RETRY_DELAY_MS)
    expect(panels.register).toHaveBeenCalledTimes(2)
    expect(warns).toEqual([expect.stringContaining('registered on retry')])
  })

  it('burns the bounded budget on a permanent refusal without throwing', () => {
    vi.useFakeTimers()
    const panels = stubPanels()
    panels.register.mockImplementation(() => undefined)
    const { ctx, warns } = stubCtx({ tuiPanels: panels.runtime })
    expect(() => registerFindPanel(ctx, { driver: DRIVER })).not.toThrow()

    vi.advanceTimersByTime(SEAM_TOTAL_BUDGET_MS)
    expect(warns).toEqual([expect.stringContaining('failed after')])
  })

  it('does not retry a shadow-mode denial (permanent, not a boot race)', () => {
    vi.useFakeTimers()
    const panels = stubPanels()
    panels.register.mockImplementation(() => {
      throw new Error('dsh-tui: shadow policy denies register in passive-shadow mode')
    })
    const { ctx, warns, infos } = stubCtx({ tuiPanels: panels.runtime })
    registerFindPanel(ctx, { driver: DRIVER })

    // One attempt, one info line: retrying a capability the run denies for its
    // whole lifetime would burn the budget and then announce a give-up that
    // never was ("the seam never mounted").
    vi.advanceTimersByTime(SEAM_TOTAL_BUDGET_MS)
    expect(panels.register).toHaveBeenCalledTimes(1)
    expect(warns).toEqual([])
    expect(infos).toEqual([expect.stringContaining('shadow policy denies')])
  })

  it('resolves the host-assigned panel id and wires the driver badge', () => {
    const panels = stubPanels()
    const { ctx } = stubCtx({ tuiPanels: panels.runtime })
    const driver = { bindBadge: vi.fn() } as unknown as FindPanelDriver
    registerFindPanel(ctx, { driver })

    // The id the host lands is NOT the plugin's `<pluginId>:search` form: it is
    // whatever `list()` answers with (a component identity when the activation
    // has one, `act<N>:search` on the direct-activation path this plugin rides).
    expect(driver.bindBadge).toHaveBeenCalledTimes(1)
    const emit = vi.mocked(driver.bindBadge).mock.calls[0]![0]
    emit({ level: 'info', unread: 0 })
    expect(panels.badge).toHaveBeenCalledWith('act1:search', { level: 'info', unread: 0 })
  })

  it('skips the badge wiring when the host cannot list its own panels', () => {
    const panels = stubPanels()
    // A drifted service without `list`: registration still works (the panel is
    // what matters), the background badge is simply not offered.
    const runtime = { register: panels.runtime.register } as Record<string, unknown>
    const { ctx, warns } = stubCtx({ tuiPanels: runtime })
    const driver = { bindBadge: vi.fn() } as unknown as FindPanelDriver
    registerFindPanel(ctx, { driver })
    expect(panels.register).toHaveBeenCalledTimes(1)
    expect(driver.bindBadge).not.toHaveBeenCalled()
    expect(warns).toEqual([])
  })
})

describe('FindPanelRegistration', () => {
  /** A handle over a stub register call, as registerFindPanel returns. */
  function registration(panels: ReturnType<typeof stubPanels>, ctx: Ctx) {
    return new FindPanelRegistration(() => registerFindPanel(ctx, { driver: DRIVER }))
  }

  it('registers once while enabled and disposes when switched off', () => {
    const panels = stubPanels()
    const { ctx } = stubCtx({ tuiPanels: panels.runtime })
    const handle = registration(panels, ctx)

    handle.sync(true)
    expect(panels.descriptors).toHaveLength(1)
    // Idempotent: the settings callback fires on every applied change, not
    // only on the toggle.
    handle.sync(true)
    expect(panels.register).toHaveBeenCalledTimes(1)

    handle.sync(false)
    expect(panels.descriptors).toEqual([])
    // Off is not a temporary state: a later toggle back on registers again
    // (a NEW registration — the host assigns a fresh id), while staying off
    // never re-registers.
    handle.sync(false)
    expect(panels.register).toHaveBeenCalledTimes(1)
    handle.sync(true)
    expect(panels.register).toHaveBeenCalledTimes(2)
    handle.dispose()
    expect(panels.descriptors).toEqual([])
  })

  it('releases a registration that lands after the switch went off', () => {
    vi.useFakeTimers()
    const panels = stubPanels()
    const { ctx, provide } = stubCtx({})
    const handle = registration(panels, ctx)

    // Enabled while the service is still missing: the late-mount poll is armed.
    handle.sync(true)
    expect(panels.register).not.toHaveBeenCalled()
    // …and the user turns it off before the service appears.
    handle.sync(false)

    // The service mounts later. The armed poll must NOT register a panel the
    // user already turned off — the host would re-append its id to the enable
    // list and the panel would come back on the next boot.
    provide('tuiPanels', panels.runtime)
    vi.advanceTimersByTime(SEAM_MOUNT_DELAY_MS * 2)
    expect(panels.register).not.toHaveBeenCalled()
  })
})
