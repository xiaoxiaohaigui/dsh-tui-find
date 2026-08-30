# dsh-tui-find

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

Uninstalling only affects this plugin: session data lives under `~/.dsh` / `~/.dsh-tui`, the plugin was strictly read-only with no on-disk index, and removing it leaves your sessions untouched.

## Usage

| Action | Description |
|---|---|
| `/find <query>` | Jump straight to results (e.g. `/find backoff`) |
| `/find` | Open the full-screen search scene |
| `Ctrl+Shift+F` | Global shortcut entry |

Keys inside the scene:

| Key | Action |
|---|---|
| any character | Instant filtering (fzf-style, purely in-memory, zero I/O); with an empty query, recent sessions are listed |
| `Tab` | Toggle scope: this repo ⇄ all sessions |
| `↑` `↓` / `PgUp` `PgDn` | Move between entries / page |
| `Alt+P` | Read-only preview (2 context messages each side + session header) |
| `Alt+C` | Copy the hit's original text (role + timestamp included) |
| `Alt+E` | Expand / collapse all hits of the selected session |
| `↵` | Resume session (**double confirmation**; loud warning while the live session is working) |
| `Esc` | Clear query / go back / close the scene |

> Preview and copy live on `Alt+` chords only: bare letters always type into the query and never trigger shortcuts.

Results are grouped per session, hits are highlighted, each session shows its first 3 hits (`(+N)` hint), most-recent-first.

## Search semantics

- **Indexed**: user messages, assistant text, session titles, tool-call summaries (`[name] arguments`).
- **Not indexed by default**: thinking text (opt-in via config).
- **Matching**: case-insensitive substring (CJK-correct by construction, no segmenter).
- **Default scope**: current repo (session cwd matched against the live channel cwd — the same semantics as the resume browser, subdirectory sessions included).

## Configuration

Override on the plugin row in `cordis.patch.yml` (all keys optional):

```yaml
- insert:
    - id: dsh-tui-find
      name: 'dsh-tui-find'
      defaultScope: 'all'        # initial scope: repo (default) | all
      caseSensitive: false       # case-sensitive matching (default off)
      indexTools: true           # index tool-call summaries (default on)
      indexThinking: false       # index thinking text (default off)
      sessionRoot: ''            # manual session root override
      maxMessageChars: 4000      # per-message index character budget
      lang: 'auto'               # zh | en | auto (follow the host language)
```

`lang: auto` follows the dsh-TUI language chain: `DSH_TUI_LANG` env → `~/.dsh-tui/lang.json` → OS locale → zh. A `/lang` switch updates the plugin copy immediately.

### Editing in the `/settings` screen

Every option above except `lang` can also be changed inside the TUI: open `/settings` and enter the **dsh-tui-find (session search)** card.

| Option | Values |
|---|---|
| Default scope | This repo (default) ⇄ All sessions |
| Case-sensitive | on / off (default off) |
| Index tool calls | on / off (default on) |
| Index thinking | on / off (default off) |
| Session root override | text; blank falls back to the resolution chain below |
| Per-message index budget | number (200–65536, step 100, default 4000) |

Edits save immediately (booleans/selects write on the spot, text drafts confirm with Enter) into the host settings service's user layer, which overrides the plugin-row defaults by layering; the card copy follows the TUI language setting (zh / en).

## Session root resolution

Probed in this order (first hit wins):

1. Config `sessionRoot` (explicit, exclusive override)
2. `DSH_TUI_SESSION_ROOT` env var
3. `$DSH_HOME || ~/.dsh` + `/sessions`
4. `~/.dsh-tui/sessions`

## Privacy & safety

- **Read-only end to end**: session logs are opened 'r' only; the history lock is never touched and history is never rewritten.
- **No on-disk index**: scan results live in memory behind an mtime+size cache; no new copies of your conversations are written anywhere.
- **Tolerant**: a torn final frame (crash mid-flush) is recognized structurally per RFC 8878 and skipped — never fatal, never leaves residue.
- **Resume needs confirmation**: resuming discards the current context, so `↵` asks twice, with a loud warning while the live session is still working.

## Development

```bash
npm install        # dev dependencies (build & test)
npm run build      # tsc → dist/
npm test           # vitest: frames / scanner / search / event sanitization / display width / admission & mount
npm run fixtures   # synthesize session fixtures (zstd chains + plain + corruption cases)
```

Test coverage (75 tests):

- **Frame chain**: multi-frame walk, torn tails, coincidental-magic rejection, reserved-block rejection, RLE blocks, single-segment/checksum header shapes, the 64 MB decode cap, plain-JSONL fallback.
- **Scanner**: zstd/plain content parity, mtime cache reuse (second sweep decodes nothing), incremental re-decode after append, corruption tolerance, the indexTools switch, AbortSignal.
- **Search**: case folding + highlight ranges, CJK substrings, tool summaries, repo/all scope filtering (subdirectory sessions and container boundaries included).
- **Event sanitization**: terminal control-byte and C1/DEL stripping, CR/tab folding, control-only message drops, header cwd and session-title sanitization.
- **Display width**: CJK/emoji double-width, head/tail truncation, spread rows, physical-line scroll windows (two-line card budget), hit-line flattening/windowing/range mapping.
- **Admission**: the manifest parses and projects under the host's own `@dsh-std/manifest` v0.15 parser with exact contract declarations; real cordis fibers mount the plugin (scene register/open/close, settings card, mediated-command degradation path) and the language pin reverts on deactivation.

## Requirements

- dsh-TUI v0.9+ (v0.15 community-draft plugin system)
- Node `^22.19 || >=24`
- Windows / macOS / Linux (frame walking is pure Buffer math — platform independent)

## License

MIT
