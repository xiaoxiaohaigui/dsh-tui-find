/**
 * Role-colour generation dispatch: the assistant brand key follows the host
 * palette generation (`claude` on 0.9.x, `accent` on 0.10+, resolved by a
 * structural probe of the injected ui kit), while the other roles keep their
 * generation-stable keys. Pinned against the real installed host kit the
 * harness also renders with, plus synthetic kits for both generations.
 */
import { describe, expect, it } from 'vitest'
import * as hostUi from '../node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ui.js'
import { roleMarkColor, type Ui } from '../src/find-types.js'

describe('roleMarkColor', () => {
  it('keeps the user/tool keys on every generation', () => {
    const bare = {} as Ui
    expect(roleMarkColor(bare, 'user')).toBe('suggestion')
    expect(roleMarkColor(bare, 'tool')).toBe('warning')
  })

  it('falls back to claude when the kit lacks the 0.10 image hooks', () => {
    expect(roleMarkColor({} as Ui, 'assistant')).toBe('claude')
    expect(roleMarkColor({ useTerminalImages: 'not-a-function' } as unknown as Ui, 'assistant')).toBe('claude')
  })

  it('yields accent when the kit speaks the 0.10 image hooks', () => {
    expect(roleMarkColor({ useTerminalImages: () => undefined } as unknown as Ui, 'assistant')).toBe('accent')
  })

  it('answers a brand key the installed kit can render, whatever its generation', () => {
    // The two synthetic cases above own the generation dispatch. Deriving the
    // expectation from the same probe would mirror the implementation (it can
    // only fail if the probe and the function disagree about a hook the test
    // reads itself), so this one claims only what the dev baseline can: the
    // REAL installed kit goes through the probe and yields a renderable key.
    expect(['claude', 'accent']).toContain(roleMarkColor(hostUi as unknown as Ui, 'assistant'))
  })
})
