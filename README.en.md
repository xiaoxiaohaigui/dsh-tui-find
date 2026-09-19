# dsh-tui-find

![dsh-tui-find cover](./assets/dsh-tui-find-cover-title.png)

**Cross-session full-text search for dsh-TUI** — instant incremental search across all local dsh sessions (zstd frame chains + plain JSONL): read the context, copy the text, resume the session.

[中文说明](./README.md) · MIT · Zero runtime dependencies

- Repository: https://github.com/xiaoxiaohaigui/dsh-tui-find
- npm: https://www.npmjs.com/package/dsh-tui-find

## What it is

[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) ships a resume browser, in-session `/` search and Ctrl+R input history — but no cross-session content search: once a conversation scrolls out of the window it becomes an unsearchable archive. This plugin closes that gap:

- **Instant**: fzf-style in-memory filtering with results streaming in; multi-term AND, JS regex, pinyin (full readings / initials), title-only mode, time windows.
- **Readable & copyable**: the split layout (list on the left, conversation reader on the right, styled after /resume) or a full-screen preview — anchored on the hit with highlighting, one-key copy of the text or the log path.
- **Resumable**: `↵` resumes the session with double confirmation; context menu on right-click (0.10+ hosts only).

## Install

```bash
dsh plugin --profile dsh-tui add -w dsh-tui-find@latest
```

Replace `dsh-tui` with your actual profile name (a directory under `$DSH_HOME/profiles/`; the default root is `~/.dsh` when `DSH_HOME` is unset). The CLI registers the package into the profile's bundle list and applies the bundled `cordis.patch.yml` automatically — no config editing needed; restart dsh-TUI (or run `/restart`) after install / upgrade / removal — the host's `/reload` never reloads plugin code.

Local development install: `npm install && npm pack` (the prepack hook builds and runs the full test suite), then `dsh plugin --profile dsh-tui add -w ./dsh-tui-find-<version>.tgz`; never install the source directory directly.

## Upgrade & uninstall

Upgrade: re-run the install command (idempotent); if the version doesn't move, `npm cache clean --force`, then verify via `/plugins` after a restart.

Uninstall: `dsh plugin --profile dsh-tui remove -w dsh-tui-find`, then restart. If the profile's `package.json → dsh.profile.bundles` still lists the entry (CLI version differences), delete it manually; settings saved through `/settings` stay in settings.yaml and reapply after a reinstall — delete the `dsh-tui-find` namespace keys for a clean slate. Uninstalling only affects this plugin: session data is strictly read-only and untouched.

## Usage

| Action | Description |
|---|---|
| `/find <query>` | Jump straight to results (space-separate multiple terms) |
| `/find` | Open the full-screen search scene |
| `Alt+F` | Global shortcut entry (remap or `off` via the `shortcut` config) |

Keys inside the scene:

| Key | Action |
|---|---|
| any character | Instant filtering; an empty query lists recent sessions |
| `Tab` / `Alt+T` | Scope (this repo ⇄ all) / time window (all ⇄ last 7 days ⇄ last 30 days) |
| `Alt+R` / `Alt+N` | Regex matching / title-only search |
| `↑↓` / `PgUp` `PgDn` | Move between entries / page |
| `→` / `←` | Split layout: → focuses the reader pane, ← returns to the list (the pane is always on screen — nothing to open or close) |
| `Alt+P` | Classic layout: open the full-screen preview (anchored on the hit, highlighted); in the reader `↑↓` scroll line by line, `PgUp`/`PgDn` page, `n`/`N` jump between hits (wrapping), the wheel scrolls by notch |
| `Alt+C` / `Alt+E` | Copy the hit's text (in the preview, the current hit: the one n/N is parked on, or the nearest hit above the viewport after free scrolling; falls back to the top message when the session has no hits) / fold, unfold this session's hits (the row-end `▸ (+N)` badge's own action) |
| `Alt+H` | Keyboard-help panel |
| `↵` / `Esc` | Resume session (double confirmation) / clear the query, go back, exit |

Mouse: left-click selects, hover highlights, the wheel moves the selection by the host's own notch size (about 3 rows per notch; inside the reader it scrolls the reader by notch); a session with more than three hits carries a `▸ (+N)` badge at the right end of its last visible hit row — **click it to reveal the session's remaining hits** (it turns into `▴ less` in place — the triangle flips to mean "fold back up" — and lights up on hover; it is the one control whose click does not follow the row, which selects and opens the resume confirmation); right-click opens a context menu (0.10+ hosts only): copy message text / copy session log path / resume this session.

> The scene layout is picked by the `layout` config: `split` (default) shows the list and a conversation reader side by side on terminals ≥ 100 columns (styled after the /resume browser) — the selection anchors the reader, the pane scrolls / copies / right-clicks on its own, and `→` focuses the pane while `←` returns to the list (`Alt+P` is not used in split); narrower terminals fall back to the single column automatically. `classic` keeps the single-column list with the full-screen `Alt+P` preview.

> The reader is a **read-only view with no cursor**: `↑↓` scroll it line by line, `PgUp`/`PgDn` and the wheel move it by page / notch, and `n`/`N` jump to the next / previous hit outside the window (wrapping) — a selection means nothing in a read-only preview, so the window itself is the position. That also leaves exactly one highlighted surface per screen: the pane carries no emphasis under list focus, and after the `→` handoff its frame lights up while the list keeps its own highlight. In both forms the reader **keeps the keyword on screen**: when a hit sits too deep in its message for the viewport, the reader opens windowed onto the hit's own line instead of parking on a message head that hides it. The hint line is width-fitted too — it drops its lowest-priority keys first (scroll and the way out always stay) and truncates as a last resort, so it is exactly one row at any width instead of wrapping into a content row.

> Results are grouped per session, the first 3 hits show per session (`(+N)` hint), most-recent-first; the scan starts the moment the scene opens and results stream in, with live progress in the header.

> About 10 seconds after startup the plugin pre-builds the index in the background (disable via the `warmup` config), so the first `/find` opens instantly; 0.10+ hosts show an "indexing n/m" row above the prompt — click it to cancel. The warm-up only moves the cold decode into idle time; it does not reduce total decoding.

> The default is `Alt+F`, not `Ctrl+Shift+F`: mainstream terminals reserve that chord for their own find UI and intercept it. On a conflict, remap via the `shortcut` config to any combo carrying `Ctrl` or `Alt`.

## Search semantics

- **Indexed**: user messages, assistant text, session titles; tool-call summaries with `indexTools`, thinking text with `indexThinking`.
- **Matching**: case-insensitive substring by default (CJK-correct by construction, no segmenter); multi-term AND (double-quoted phrases keep their inner spaces, at most 16 terms); regex mode treats the whole query as ONE pattern — no term splitting.
- **Pinyin** (on by default, disable via `pinyin`): letter-only terms also match Chinese — full readings (`zhangsan` → 张三), default-reading chains (`zhongqing` → 重庆), initials (`zs` → 张三, `bjdx` → 北京大学 — one letter per character, contiguous across words); full readings match from a syllable start (a syllable tail never joins the next character's initial) while initials concatenate the way you type them; polyphones use every reading, ü is written as v; a 3500-character reading table ships built in, out-of-table characters fold to themselves; regex mode is never pinyin-expanded.
- **Title-only** (`Alt+N` toggles live): session titles only, message bodies excluded — for "find that session"; untitled sessions cannot match.
- **Default scope**: current repo (session cwd matched against the live channel cwd, the resume browser's semantics, subdirectory sessions included).

## Configuration

Override on the plugin row in `cordis.patch.yml` (all keys optional):

```yaml
- insert:
    - id: dsh-tui-find
      name: 'dsh-tui-find'
      defaultScope: 'all'        # initial scope: repo (default) | all
      defaultTime: 'all'         # initial time window: all (default) | 7d | 30d
      layout: 'split'            # scene layout: split (default, list + reader, needs >= 100 columns) | classic (single column + full-screen preview)
      caseSensitive: false       # case-sensitive matching (default off)
      regex: false               # start with regex matching on (default off; Alt+R toggles it live)
      pinyin: true               # pinyin matching (default on; letter-only terms also match Chinese via readings + initials)
      titleOnly: false           # title-only search (default off; Alt+N toggles it live)
      indexTools: false          # index tool-call summaries (default off)
      indexThinking: false       # index thinking text (default off)
      sessionRoot: ''            # manual session root override
      maxMessageChars: 4000      # per-message index character budget
      warmup: true               # background warm-up index (default on; off = /find scans on open)
      lang: 'auto'               # zh | en | auto (follow the host language)
      shortcut: 'alt+f'          # global entry combo (ctrl or alt required; 'off' disables the entry)
```

Every option except `lang` can also be edited in the TUI: `/settings` → the **dsh-tui-find (session search)** card. Booleans/selects save on the spot, text drafts confirm with Enter — into the host settings service's user layer, overriding the plugin-row defaults by layering; the card copy follows the TUI language.

`lang: auto` follows the dsh-TUI language chain: `DSH_TUI_LANG` → `~/.dsh-tui/lang.json` → OS locale → zh; a `/lang` switch applies immediately.

Session root is probed in order (first hit wins): the `sessionRoot` config (exclusive override) → the `DSH_TUI_SESSION_ROOT` env var → `$DSH_HOME || ~/.dsh` + `/sessions` → `~/.dsh-tui/sessions`.

## Privacy & safety

- **Read-only end to end**: logs are opened read-only; the history lock is never touched, history is never rewritten.
- **Generation naming**: dsh logs are named per format generation (`session.jsonl`, `session.vN.jsonl`, each with a `.zstd` variant). A session directory is read from its numerically highest generation, compressed winning within one — a retired generation left behind in a migration window is never indexed.
- **Minimal disk footprint**: conversation content lives only in memory, never on disk. The single written file is the watermark journal `~/.dsh-tui/dsh-tui-find/watermark.json` — paths plus byte/mtime/offset metadata only, never conversation text (0700/0600 + tmp+rename atomic write; `DSH_TUI_FIND_WATERMARK=off` disables it).
- **Incremental decode & tolerance**: appends decode only new frames, a same-size touch decodes nothing, shrink/rewrite/encoding flips fall back to a full decode; a torn final frame is recognized per RFC 8878 and skipped — never fatal, never residue.
- **Resume needs confirmation**: resuming discards the current context; `↵` asks twice, with a loud warning while the live session is still working.

## Development

```bash
npm install          # dev dependencies
npm run build        # tsc → dist/
npm test             # pretest builds and generates fixtures, then runs the full vitest suite
npm run verify:hosts # dual-host matrix: isolated-copy host swap, one build+test each on 0.9.3 and 0.10.1
```

Test coverage (349 tests): frame chains, the scanner (mtime cache reuse, offset-watermark incremental decode, generation-named enumeration), search (multi-term AND / regex / pinyin with cross-word initials / title-only / time window / scope filtering), the fold build field-by-field against a frozen pre-refactor implementation, the preview reader (hit-aware anchoring, re-landing as the query is typed, cursor-less line scrolling, window-relative n/N, the current-hit pick behind Alt+C, and a hint line that is fitted to the width and always one row), keyboard help (layout-aware vocabulary, the mouse fold badge), scene wiring (real host renderer with SGR mouse injection and right-click dispatch, including the split layout, the ←/→ focus handoff, selection anchoring, the width fallback, wheel step size, badge folding that never opens the row, and a fold leaving no hover tint on the next card), host-generation dispatch, event sanitization, display width, admission and real-fiber mounting, boot-race hardening, and the background warm-up index (budgets, abort, and the shape of the cache keys it fills) with its `tuiStatus` progress view.

## Requirements

- dsh-TUI v0.9+ (v0.15 community-draft plugin system). Both 0.9.x and 0.10.x are verified (`npm run verify:hosts`); 0.10-only capabilities soft-probe and degrade gracefully — no forced host upgrade.
- Node `^22.19 || >=24`; Windows / macOS / Linux.

## License

MIT
