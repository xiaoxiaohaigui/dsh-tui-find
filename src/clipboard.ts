/**
 * Clipboard write, aligned with the host's strategy (`src/ink/termio/osc.ts`
 * `setClipboard`): native tool FIRST as the local safety net, tmux
 * `load-buffer -w` inside tmux, and raw OSC 52 as the universal path. The
 * sequence the caller must write to stdout is returned; outside tmux that is
 * the raw OSC 52, inside tmux the DCS-passthrough-wrapped variant.
 *
 * Native is gated on `SSH_CONNECTION` (over SSH those tools would write the
 * remote clipboard; OSC 52 is the right path there). Windows uses the host's
 * own tool, but by ABSOLUTE path (`%SystemRoot%\System32\clip.exe`): libuv
 * resolves a bare `clip` against the CWD first, so a project-local clip.exe
 * planted in dsh's working directory would run instead, with dsh's whole
 * environment inherited (REVIEW R-197).
 *
 * @module dsh-tui-find/clipboard
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ESC = '\u001b'
const BEL = '\u0007'

/** The native clipboard command for this platform, or undefined when there
 *  is none (or its absolute path is missing). POSIX keeps the host's
 *  PATH-resolved tool; Windows must not: `clip` is a bare name and libuv
 *  resolves it against the CWD first, so a project-local clip.exe would run
 *  with dsh's environment (REVIEW R-197). */
function nativeClipboardCommand(): string | undefined {
  switch (process.platform) {
    case 'darwin':
      return 'pbcopy'
    case 'linux':
      return 'wl-copy'
    case 'win32': {
      const root = process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows'
      const clip = join(root, 'System32', 'clip.exe')
      return existsSync(clip) ? clip : undefined
    }
    default:
      return undefined
  }
}

/** Fire-and-forget native clipboard write; failures are silent because
 *  OSC 52 may still have succeeded. */
function copyNative(text: string): void {
  try {
    const command = nativeClipboardCommand()
    if (command === undefined) return
    const child = spawn(command, [], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', () => {})
    child.stdin?.on('error', () => {})
    child.stdin?.end(text, 'utf8')
  } catch {
    // Native is a safety net only.
  }
}

/**
 * Copy `text` to the clipboard.
 *
 * @param stdout - Writable to receive the OSC 52 sequence (the TUI's stdout).
 * @param writeStdout - Whether to write the sequence (tests pass false).
 * @returns The sequence that was (or would be) written.
 */
export function copyToClipboard(
  text: string,
  stdout?: NodeJS.WriteStream,
  writeStdout = true,
): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64')

  // Native safety net first (same ordering rationale as the host: a quick
  // focus switch after triggering copy must not race the native path).
  if (!process.env['SSH_CONNECTION']) copyNative(text)

  // Inside tmux, load the buffer (-w propagates to the outer terminal) and
  // wrap the OSC 52 in tmux's DCS passthrough. Inner ESCs must be doubled.
  if (process.env['TMUX']) {
    const inner = `${ESC}]52;c;${b64}${BEL}`
    const wrapped = `${ESC}Ptmux;${inner.replaceAll(ESC, ESC + ESC)}${ESC}\\`
    if (writeStdout && stdout !== undefined) stdout.write(wrapped)
    return wrapped
  }

  const raw = `${ESC}]52;c;${b64}${BEL}`
  if (writeStdout && stdout !== undefined) stdout.write(raw)
  return raw
}
