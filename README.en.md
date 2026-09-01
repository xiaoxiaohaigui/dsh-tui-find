# dsh-tui-find

![dsh-tui-find cover](./assets/dsh-tui-find-cover-title.png)

**Cross-session full-text search for dsh-TUI** — turn "I remember discussing/generating X in some session" into "found it, readable, copyable, resumable" within seconds.

[中文说明](./README.md) · MIT · Zero runtime dependencies

- Repository: https://github.com/xiaoxiaohaigui/dsh-tui-find
- npm: https://www.npmjs.com/package/dsh-tui-find

## What it is

[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) (`@deepseek-harness-tui/dsh-tui`) ships a resume browser, in-session `/` search, and Ctrl+R input history — but **no cross-session content search**. Once a conversation scrolls out of the current window it becomes an unsearchable archive.

`dsh-tui-find` closes that gap: instant incremental content search across **all local dsh sessions** (the default zstd frame-chain storage plus plain JSONL), with read-only context preview, one-key copy, and session resume.

## Install

> **Development notice**: the project is in its 0.x stage; interfaces and config keys may change between versions. See upgrade/uninstall below.

**Option 1: from npm (published)**

```bash
dsh plugin --profile dsh-tui add -w dsh-tui-find@latest
```

`dsh plugin ... add` forwards its arguments to pnpm inside the profile directory (`--profile` is required; `-w` allows operating on the profile root directly) and picks up the package's bundled `cordis.patch.yml` automatically as a composition layer — no config editing needed.

**Option 2: local tarball (development/self-use; never install the source directory directly)**

```bash
cd /path/to/dsh-tui-find
npm install        # first time only
npm pack           # the prepack hook builds and runs the full test suite
dsh plugin --profile dsh-tui add -w ./dsh-tui-find-<version>.tgz
```

Replace `dsh-tui` in `--profile` with your actual profile name (a directory under `$DSH_HOME/profiles/`; when `DSH_HOME` is unset the default root is `~/.dsh`).

### Mounting mechanics

After `dsh plugin ... add`, the CLI registers the package into the profile's `package.json → dsh.profile.bundles` list; the package's own `cordis.patch.yml` is applied as a composition layer in bundle order: `dsh-base → other bundles → dsh-tui-find patch → user profile patch`. No manual config editing is required under normal circumstances. Installs, upgrades and removals change the profile's composition tree — restart dsh-TUI (or run `/restart`) for new code to load or removed code to unload; the host's `/reload` only re-reads preference files, never plugin code.

## Upgrade

Re-run the install command pinned to `@latest` (`dsh plugin ... add` is idempotent):

```bash
dsh plugin --profile dsh-tui add -w dsh-tui-find@latest
```

If the new version does not appear, refresh the npm cache first: `npm cache clean --force`. Restart dsh-TUI (or run `/restart`) to load the new version, then verify via `/plugins` (or `/plugins check`) inside the TUI.

## Uninstall

Three steps, all reversible, none touch the host core; restart dsh-TUI (or run `/restart`) for them to take effect:

1. **Remove the package** (this also drops the bundle from the resolution tree):

```bash
dsh plugin --profile dsh-tui remove -w dsh-tui-find
```

2. **Confirm the bundle list is clean**: if `dsh-tui-find` still appears in the `dsh.profile.bundles` array of `$DSH_HOME/profiles/dsh-tui/package.json` (CLI version differences), delete that entry manually.

3. **(Optional) clean up settings residue**: values saved through `/settings` live in the host settings service's user layer (settings.yaml); they survive uninstall and keep applying after a reinstall (same layering rules). For a fully clean slate, delete the `dsh-tui-find` namespace keys from that file.

> Manual mounts (a row inserted into the profile's `cordis.patch.yml` by hand): remove the package as in step 1 first, then delete the inserted row.

Uninstalling only affects this plugin: session data lives under `~/.dsh` / `~/.dsh-tui`, the plugin is strictly read-only, and your search history disappears with it — sessions themselves are untouched. The only file it writes is the watermark journal (`~/.dsh-tui/dsh-tui-find/watermark.json`, file metadata only, see the next section); delete the whole `~/.dsh-tui/dsh-tui-find/` directory for a fully clean slate.

## Usage

| Action | Description |
|---|---|
| `/find <query>` | Jump straight to results (e.g. `/find backoff`) |
| `/find` | Open the full-screen search scene |
| `Alt+F` | Global shortcut entry (default; remap or disable via the `shortcut` config) |

Keys inside the scene:

| Key | Action |
|---|---|
| any character | Instant filtering (fzf-style, purely in-memory, zero I/O); with an empty query, recent sessions are listed |
| `Tab` | Toggle scope: this repo ⇄ all sessions |
| `Alt+R` | Toggle regex matching (JS syntax; an invalid pattern shows a notice and matches nothing) |
| `Alt+T` | Cycle the time window: all ⇄ last 7 days ⇄ last 30 days (by session modification time) |
| `↑` `↓` / `PgUp` `PgDn` | Move between entries / page |
| `Alt+P` | Read-only preview (2 context messages each side + session header) |
| `Alt+C` | Copy the hit's original text (role + timestamp included) |
| `Alt+E` | Expand / collapse all hits of the selected session |
| `↵` | Resume session (**double confirmation**; loud warning while the live session is working) |
| `Esc` | Clear query / go back / close the scene |

Mouse:

| Action | Behavior |
|---|---|
| Left-click a row | Select it and open the same resume confirmation as `↵` |
| Hover a row | Move the selection and highlight the row |
| Wheel | Move the selection one row up or down |

> Mouse support depends on dsh-TUI's fullscreen mouse tracking. The dsh-TUI 0.9.3 published package exposes left-click, hover, and wheel events, but does not expose a right-button `onContextMenu` event, so this version does not show a context menu; keyboard shortcuts remain the complete action surface.

> Preview and copy live on `Alt+` chords only: bare letters always type into the query and never trigger shortcuts.

> **Why the default is not `Ctrl+Shift+F`**: mainstream terminals (Windows Terminal, VS Code, GNOME Terminal, …) reserve that chord for their own find UI, intercepting the keypress before dsh-TUI ever sees it. The default is now `Alt+F` to avoid QQ's `Ctrl+Alt+F` conflict; if your terminal happens to use it, remap via the `shortcut` config to any combo carrying `Ctrl` or `Alt`.

Results are grouped per session, hits are highlighted, each session shows its first 3 hits (`(+N)` hint), most-recent-first.

## Search semantics

- **Indexed**: user messages, assistant text, and session titles; tool-call summaries (`[name] arguments`) are included when `indexTools` is enabled.
- **Not indexed by default**: thinking text (opt-in via config).
- **Matching**: case-insensitive substring by default (CJK-correct by construction, no segmenter); `Alt+R` switches to JS regex mode (case sensitivity follows the case-sensitive switch; invalid, oversized, or potentially catastrophic patterns are rejected and show a notice).
- **Time window**: `Alt+T` filters by session modification time (all ⇄ last 7 days ⇄ last 30 days), applying to both search results and the empty-query recent list; the initial window comes from the `defaultTime` config (default all).
- **Default scope**: current repo (session cwd matched against the live channel cwd — the same semantics as the resume browser, subdirectory sessions included).

## Configuration

Override on the plugin row in `cordis.patch.yml` (all keys optional):

```yaml
- insert:
    - id: dsh-tui-find
      name: 'dsh-tui-find'
      defaultScope: 'all'        # initial scope: repo (default) | all
      defaultTime: 'all'         # initial time window: all (default) | 7d | 30d
      caseSensitive: false       # case-sensitive matching (default off)
      regex: false               # start with regex matching on (default off; Alt+R toggles it live)
      indexTools: false          # index tool-call summaries (default off)
      indexThinking: false       # index thinking text (default off)
      sessionRoot: ''            # manual session root override
      maxMessageChars: 4000      # per-message index character budget
      lang: 'auto'               # zh | en | auto (follow the host language)
      shortcut: 'alt+f'           # global entry combo (ctrl or alt required; 'off' disables the entry)
```

`lang: auto` follows the dsh-TUI language chain: `DSH_TUI_LANG` env → `~/.dsh-tui/lang.json` → OS locale → zh. A `/lang` switch updates the plugin copy immediately.

### Editing in the `/settings` screen

Every option above except `lang` can also be changed inside the TUI: open `/settings` and enter the **dsh-tui-find (session search)** card.

| Option | Values |
|---|---|
| Default scope | This repo (default) ⇄ All sessions |
| Default time window | All time (default) ⇄ Last 7 days ⇄ Last 30 days |
| Case-sensitive | on / off (default off) |
| Regex matching | on / off (default off; `Alt+R` toggles it live in the scene) |
| Index tool calls | on / off (default off) |
| Index thinking | on / off (default off) |
| Session root override | text; blank falls back to the resolution chain below |
| Per-message index budget | number (200–65536, step 100, default 4000) |
| Global shortcut | text; the combo must carry `Ctrl` or `Alt`, `off` disables; default `Alt+F` (an invalid draft falls back to the default with a warning) |

Edits save immediately (booleans/selects write on the spot, text drafts confirm with Enter) into the host settings service's user layer, which overrides the plugin-row defaults by layering; the card copy follows the TUI language setting (zh / en).

## Session root resolution

Probed in this order (first hit wins):

1. Config `sessionRoot` (explicit, exclusive override)
2. `DSH_TUI_SESSION_ROOT` env var
3. `$DSH_HOME || ~/.dsh` + `/sessions`
4. `~/.dsh-tui/sessions`

## Privacy & safety

- **Read-only end to end**: session logs are opened 'r' only; the history lock is never touched and history is never rewritten.
- **Minimal disk footprint**: conversation content lives only in memory (behind an mtime+size cache); no copies of your conversations are ever written. The single exception is the watermark journal `~/.dsh-tui/dsh-tui-find/watermark.json` — it records log paths plus byte counts, mtimes and offsets as file metadata, **never conversation text**; 0700 directory / 0600 file, tmp+rename atomic write, and `DSH_TUI_FIND_WATERMARK=off` disables it entirely. It is an observation record for incremental decoding: a cold start still decodes every prefix, and the journal never drives decode decisions.
- **Incremental decode**: after a session log grows, only the new frames are decoded (offset watermark + append-only boundary proof); a same-size touch decodes nothing, while a shrink, a detected rewrite, or an encoding flip falls back to a full decode. The prefix check covers every byte before the watermark.
- **Tolerant**: a torn final frame (crash mid-flush) is recognized structurally per RFC 8878 and skipped — never fatal, never leaves residue; frames the writer completes after the crash are picked up by the incremental path, neither duplicated nor lost.
- **Resume needs confirmation**: resuming discards the current context, so `↵` asks twice, with a loud warning while the live session is still working.

## Development

```bash
npm install        # dev dependencies (build & test)
npm run build      # tsc → dist/
npm run fixtures   # synthesize session fixtures (zstd chains + plain + corruption cases)
npm test           # vitest: frames / scanner / search / event sanitization / display width / admission & mount
```

Test coverage (114 tests):

- **Frame chain**: multi-frame walk, torn tails, coincidental-magic rejection, reserved-block rejection, RLE blocks, single-segment/checksum header shapes, the 64 MB decode cap, plain-JSONL fallback.
- **Scanner**: zstd/plain content parity, mtime cache reuse (second sweep decodes nothing), zero decode on a same-size touch (boundary-verified), the offset-watermark suite (zstd/plain appends decode only the new frames, torn-tail completion without duplication, detected shrink and same-boundary equal-length rewrites fall back to a full decode, journal 0600/0700 posture and cold-start full decode), corruption tolerance, the indexTools/indexThinking switches, AbortSignal.
- **Search**: case folding + highlight ranges, CJK substrings, regex mode (per-match ranges, case-sensitivity follow, invalid/oversized/unsafe patterns rejected, zero-width safety), the `sinceMs` time window (boundary included), tool summaries, repo/all scope filtering (subdirectory sessions and container boundaries included), result idempotence.
- **Event sanitization**: terminal control-byte and C1/DEL stripping, CR/tab folding, control-only message drops, header cwd and session-title sanitization.
- **Display width**: CJK/emoji double-width, head/tail truncation, spread rows, physical-line scroll windows (two-line card budget), hit-line flattening/windowing/range mapping.
- **Admission**: the manifest parses and projects under the host's own `@dsh-std/manifest` v0.15 parser with exact contract declarations; real cordis fibers mount the plugin (scene register/open/close, settings card, mediated-command degradation path) and the language pin reverts on deactivation.
- **Boot-race hardening**: the guarded-seam retry helper (retry landing, bounded give-up, timer cleanup on deactivation); a forced cold-start interleaving against the real host `TuiSceneRuntime` where a bare register is rejected by the liveness gate (canary assertion pins the race) while the plugin lands its scene via the retry, and the healthy interleaving keeps registering synchronously.

## Requirements

- dsh-TUI v0.9+ (v0.15 community-draft plugin system)
- Node `^22.19 || >=24`
- Windows / macOS / Linux (frame walking is pure Buffer math — platform independent)

## License

MIT
