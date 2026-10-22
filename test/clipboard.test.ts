/**
 * Clipboard strategy: OSC 52 always, the native tool first as a local safety
 * net. The Windows branch must launch `%SystemRoot%\System32\clip.exe` by
 * ABSOLUTE path: libuv resolves a bare `clip` against the CWD first, so a
 * project-local clip.exe planted in dsh's working directory would execute
 * with dsh's whole environment (REVIEW R-197). The POSIX branches keep the
 * host's PATH-resolved tools (their risk is an already-hijacked PATH).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { copyToClipboard } from '../src/clipboard.js'

/** The only members copyNative touches on the child process. */
const fakeChild = () => ({
  on: vi.fn(),
  stdin: { on: vi.fn(), end: vi.fn() },
})

const originalPlatform = process.platform

/** process.platform is a configurable value property (not a getter), so the
 *  Windows branch can be exercised on any runner. */
const setPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  spawnMock.mockReset()
  spawnMock.mockImplementation(fakeChild)
  // Take the native path: neither the SSH gate nor the tmux wrapper applies.
  vi.stubEnv('SSH_CONNECTION', '')
  vi.stubEnv('TMUX', '')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  vi.unstubAllEnvs()
})

describe('native clipboard tool', () => {
  it('launches Windows clip.exe by absolute path, never the bare name (R-197)', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tui-find-clip-'))
    try {
      mkdirSync(join(root, 'System32'), { recursive: true })
      writeFileSync(join(root, 'System32', 'clip.exe'), '')
      vi.stubEnv('SystemRoot', root)
      setPlatform('win32')

      copyToClipboard('hello', undefined, false)

      expect(spawnMock).toHaveBeenCalledTimes(1)
      const command = spawnMock.mock.calls[0]?.[0] as string
      expect(command).toBe(join(root, 'System32', 'clip.exe'))
      expect(isAbsolute(command)).toBe(true)
      expect(command).not.toBe('clip')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips the native tool when the absolute clip.exe is missing (R-197)', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tui-find-clip-missing-'))
    try {
      vi.stubEnv('SystemRoot', root)
      setPlatform('win32')

      copyToClipboard('hello', undefined, false)

      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the OSC 52 fallback and the POSIX tools', () => {
    setPlatform('linux')

    const sequence = copyToClipboard('hi', undefined, false)

    expect(sequence).toBe(`\u001b]52;c;${Buffer.from('hi', 'utf8').toString('base64')}\u0007`)
    expect(spawnMock).toHaveBeenCalledWith(
      'wl-copy',
      [],
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] }),
    )
  })
})
