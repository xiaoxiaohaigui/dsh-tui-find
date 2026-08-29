# dsh-tui-find

**Cross-session full-text search for dsh-TUI** — turn "I remember discussing/generating X in some session" into "found it, readable, copyable, resumable" within seconds.

[中文说明](./README.md) · MIT · Zero runtime dependencies

- Repository: https://github.com/xiaoxiaohaigui/dsh-tui-find
- npm: https://www.npmjs.com/package/dsh-tui-find

## What it is

dsh-TUI (`@deepseek-harness-tui/dsh-tui`) ships a resume browser, in-session `/` search, and Ctrl+R input history — but **no cross-session content search**. Once a conversation scrolls out of the current window it becomes an unsearchable archive.

`dsh-tui-find` closes that gap: instant incremental content search across **all local dsh sessions** (the default zstd frame-chain storage plus plain JSONL), with read-only context preview, one-key copy, and session resume.

## Install

> **Development notice**: the project is in its 0.x stage; interfaces and config keys may change between versions. See upgrade/uninstall below.

```bash
dsh plugin add dsh-tui-find
```

Full form (explicit profile, matching the host ecosystem convention):

```bash
dsh plugin --profile dsh-tui add dsh-tui-find
```

Or install from source: clone this repository, `npm install && npm run build`, then inside the profile directory (`$DSH_HOME/profiles/dsh-tui/`) run `pnpm add <local path or git URL>`, and make sure the patch line below exists.

### Manual mounting

The package ships its own `cordis.patch.yml`; `dsh plugin add` mounts the plugin into the profile's bundle list automatically. Manual way — insert into `$DSH_HOME/profiles/dsh-tui/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-tui-find
      name: 'dsh-tui-find'
```

## Upgrade

Re-run the install command pinned to `@latest` (the host ecosystem's upgrade convention; `dsh plugin add` is idempotent):

```bash
dsh plugin --profile dsh-tui add dsh-tui-find@latest
```

If the new version does not appear, refresh the npm cache first: `npm cache clean --force`. Verify via `/plugins` (or `/plugins check`) inside the TUI.

## Uninstall

Two steps, both reversible, neither touches the host core:

1. **Remove the mount**: delete the `- id: dsh-tui-find` insert block from `$DSH_HOME/profiles/dsh-tui/cordis.patch.yml`; if the profile's `dsh.profile.bundles` list also references this package (appended by the CLI when installed via `dsh plugin add`), remove that entry too.
2. **Remove the package**:

```bash
cd "$DSH_HOME/profiles/dsh-tui"   # bash; PowerShell: Set-Location
pnpm remove dsh-tui-find
```

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
| any character | Instant filtering (fzf-style, purely in-memory, zero I/O) |
| `Tab` | Toggle scope: this repo ⇄ all sessions |
| `↑` `↓` / `PgUp` `PgDn` | Move between hits / page |
| `p` | Read-only preview (2 context messages each side + session header) |
| `c` | Copy the hit's original text (role + timestamp included) |
| `↵` | Resume session (**double confirmation**; loud warning while the live session is working) |
| `Esc` | Clear query / go back / close the scene |

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
npm test           # vitest: frames / scanner / search / manifest admission / mount integration
npm run fixtures   # synthesize session fixtures (zstd chains + plain + corruption cases)
```

Test coverage (37 tests):

- **Frame chain**: multi-frame walk, torn tails, coincidental-magic rejection, reserved-block rejection, RLE blocks, single-segment/checksum header shapes, the 64 MB decode cap, plain-JSONL fallback.
- **Scanner**: zstd/plain content parity, mtime cache reuse (second sweep decodes nothing), incremental re-decode after append, corruption tolerance, the indexTools switch, AbortSignal.
- **Search**: case folding + highlight ranges, CJK substrings, tool summaries, repo/all scope filtering (subdirectory sessions and container boundaries included).
- **Admission**: the manifest parses and projects under the host's own `@dsh-std/manifest` v0.15 parser with exact contract declarations; real cordis fibers mount the plugin (scene register/open/close, settings card, mediated-command degradation path).

## Requirements

- dsh-TUI v0.9+ (v0.15 community-draft plugin system)
- Node `^22.19 || >=24`
- Windows / macOS / Linux (frame walking is pure Buffer math — platform independent)

## License

MIT
