# dsh-tui-find

![dsh-tui-find cover](./assets/dsh-tui-find-cover-title.png)

**Cross-session full-text search for dsh-TUI** — instant incremental search across all local dsh sessions (zstd frame chains + plain JSONL): read the context, copy the text, resume the session.

[中文说明](./README.md) · MIT · Zero runtime dependencies

- Repository: https://github.com/xiaoxiaohaigui/dsh-tui-find
- npm: https://www.npmjs.com/package/dsh-tui-find

## What it is

[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) ships a resume browser, in-session `/` search and Ctrl+R input history — but no cross-session content search: once a conversation scrolls out of the window it becomes an unsearchable archive. This plugin closes that gap:

- **Instant**: fzf-style in-memory filtering with results streaming in as the scan runs; multi-term AND, JS regex, pinyin (full readings / initials), title-only mode, time windows.
- **Readable & copyable**: the split layout (list on the left, conversation reader on the right, styled after /resume) or a full-screen preview — anchored on the hit with highlighting, one-key copy of the text or the log path.
- **Resumable**: `↵` resumes the session with double confirmation; context menu on right-click.
- **Always in the sidebar**: the same single-column list also lives in a right-column panel — search straight from the sidebar and click a row to continue reading in the full-screen scene.

![The full-screen search scene: results grouped per session on the left, the read-only reader on the right, hits highlighted](./assets/dsh-tui-find-scene.png)

## Install

```bash
dsh plugin --profile dsh-tui add -w dsh-tui-find@latest
```

Replace `dsh-tui` with your actual profile name (a directory under `$DSH_HOME/profiles/`; the default root is `~/.dsh` when `DSH_HOME` is unset). The CLI registers the package into the profile's bundle list and applies the bundled `cordis.patch.yml` automatically — no config editing needed; restart dsh-TUI (or run `/restart`) after install / upgrade / removal — the host's `/reload` never reloads plugin code.

Local development install: `npm install && npm pack` (the prepack hook builds and runs the full test suite), then `dsh plugin --profile dsh-tui add -w ./dsh-tui-find-<version>.tgz`; never install the source directory directly.

## Upgrade & uninstall

Upgrade = re-run the install command (idempotent); if the version doesn't move, `npm cache clean --force`, then verify via `/plugins` after a restart. Uninstall: `dsh plugin --profile dsh-tui remove -w dsh-tui-find`, then restart.

If the profile's `package.json → dsh.profile.bundles` still lists the entry (CLI version differences), delete it manually; settings saved through `/settings` live on the host side (the `settings.yaml` user layer on `@deepseek-ai/dsh-settings` ≤0.1.6, the profile patch `cordis.patch.yml` on ≥0.1.7) and reapply after a reinstall. Uninstalling only affects this plugin: session data is strictly read-only and untouched.

## Usage

| Action | Description |
|---|---|
| `/find <query>` | Jump straight to results (space-separate multiple terms) |
| `/find` | Open the full-screen search scene |
| `Alt+F` | Global entry: one press opens the scene, **a second press inside it closes the scene** (remap or `off` via `shortcut`) |

Keys inside the scene:

| Key | Action |
|---|---|
| any character | Instant filtering; an empty query lists recent sessions |
| `↑↓` / `PgUp` `PgDn` | Move between entries / page |
| `Tab` | Split layout: expand / hide the workspace column (the scope follows its selected row — see below); classic layout: scope (this repo ⇄ all) |
| `Alt+T` | Time window (all ⇄ last 7 days ⇄ last 30 days) |
| `Alt+R` / `Alt+N` | Regex matching / title-only search |
| `→` / `←` | Split layout: `→` focuses the reader pane, `←` returns to the list and one more `←` enters the workspace column |
| `Alt+P` | Classic layout: open the full-screen preview (anchored on the hit, highlighted) |
| `Alt+C` / `Alt+E` | Copy the hit's text / fold, unfold this session's hits (the row-end `▸ (+N)` badge's own action) |
| `Alt+H` | Keyboard-help panel |
| `↵` / `Esc` | Resume session (double confirmation) / clear the query, go back, exit |

Mouse: left-click selects, hover highlights, the wheel moves the selection by the host's own notch size (about 3 rows per notch; inside the reader it scrolls the reader, over the workspace column it walks the workspaces). A session with more than three hits carries a `▸ (+N)` badge at the right end of its last visible hit row — click it to reveal the session's remaining hits (it turns into `▴ less` in place); it is the one control whose click does not follow the row, which selects and opens the resume confirmation. Right-click opens a context menu: copy message text / copy session log path / resume this session.

A few behaviors worth knowing:

- **Layout** is picked by the `layout` config: `split` (default) shows the list and a conversation reader side by side on terminals ≥ 100 columns (styled after the /resume browser) — the selection anchors the reader, the pane scrolls / copies / right-clicks on its own, and `→` focuses the pane while `←` returns to the list (`Alt+P` is not used in split); narrower terminals fall back to the single column automatically. `Tab` expands the workspace column on the left, turning the row into "workspaces + list + reader" (see below). `classic` keeps the single-column list with the full-screen `Alt+P` preview, where `Tab` still toggles the scope.
- **The reader has no cursor**: `↑↓` scroll it line by line, `PgUp`/`PgDn` and the wheel move it by page / notch, and `n`/`N` jump to the next / previous hit outside the window (wrapping). `Alt+C` copies the current hit (the one n/N is parked on, or the nearest hit above the viewport after free scrolling; the top message when the session has no hits). When a hit sits too deep in its message for the viewport, the reader opens windowed onto the hit's own line instead of parking on a message head that hides it.
- **Results** are grouped per session, the first 3 hits show per session (`(+N)` hint), most-recent-first; the scan starts the moment the scene opens and results stream in, with live progress in the header.
- **Warm-up**: about 10 seconds after startup the plugin pre-builds the index in the background (disable via the `warmup` config), so the first `/find` opens instantly; while the background index runs, an "indexing n/m" row sits above the prompt — click it to cancel. The warm-up only moves the cold decode into idle time; it does not reduce total decoding.

### The workspace column (split layout)

The third column `Tab` opens is the visible form of the search scope: "All sessions" is pinned on top and every workspace the sweep found gets a row (most-recently-used first). The number at the row's end is **how many sessions the sweep found in that scope** — the same rule the scope itself runs (exact cwd, subdirectories, and the resumed-into-a-subdirectory inverse; containers such as home, drive roots and UNC roots match exactly). The time window (`Alt+T`) and the query filter the middle column further, so the number can exceed what the list shows at that moment.

| Key / action | Effect |
|---|---|
| `←` (from the session list) | Enter the workspace column; press `Tab` first while it is hidden |
| `↑↓` / `PgUp` `PgDn` | Move the selection / page it by one viewport — **selecting IS applying**: the middle column and the reader follow immediately |
| `↵` / `→` | Hand the keyboard back to the session list |
| `Esc` | Back out one layer (workspace column → list) |
| hover / click | Tint only / select and hand the keyboard back (hover never switches the scope — a pointer passing over the column must not change it) |
| wheel | Move the selection (one notch = the host's ±3 rows, the same step the session list uses) — no keyboard focus needed, and selecting applies |

- **The scope IS the selected workspace**: "All sessions" means no scope at all; a workspace row matches that path (its own cwd, its subdirectories, and sessions resumed into a subdirectory) — the same semantics the old "this repo" scope had, as a list instead of a two-state toggle.
- **Both prompts follow the scope**: the search card's placeholder and the empty-list hint spell the current range, and a deep path keeps its **tail** (the last segment is what tells one workspace from another).
- **The opening row** still comes from `defaultScope` (`all` → all sessions, `repo` → the live workspace); a scope handed over by the sidebar panel wins over it.

### Global shortcut

The default is `Alt+F`, not `Ctrl+Shift+F`: mainstream terminals reserve that chord for their own find UI and intercept it. On a conflict, remap via the `shortcut` config to any combo carrying `Ctrl` or `Alt`.

- The entry is a **toggle**: pressing the same combo inside the scene exits it right away (from the list, the confirm, the preview or the help sheet alike), and the key follows the `shortcut` config. The `Alt+H` sheet spells the effective combo, and an `off` entry drops that row.
- Remapping onto a scene key (`alt+h`/`alt+t`/`alt+n`/`alt+p`/`alt+c`/`alt+e`) is **not** refused by the host — but the entry wins inside the scene: that key exits instead of doing its scene job. The plugin logs a warning and raises a toast when the binding lands, and the scene's hint line keeps naming it as taken by the entry.
- The other way round, **some combos belong to the host itself and a remap onto them never takes effect**: `alt+r` (the host's Continue), `alt+s`/`alt+v`/`alt+z`, and `ctrl+b`/`ctrl+e`/`ctrl+g`/`ctrl+k`/`ctrl+l`/`ctrl+o`/`ctrl+p`/`ctrl+q`/`ctrl+r`/`ctrl+t`/`ctrl+v`/`ctrl+z` and friends (the full set follows the host's own action bindings). The registration is refused and **the plugin keeps the previous binding** (still `alt+f` by default); the scene's hint line then reads "refused — the entry is `Alt+F`". The settings card keeps showing the value you typed, so trust the hint line.
- The toasts on these paths all start with `dsh-tui-find: `, so the host's shared notification frame says who is talking.

### Sidebar panel

The right column arrived in dsh-TUI 0.13.0 — the plugin's supported floor; the plugin registers a "Search" panel there (`⌕` tab) that carries the same single-column list — search straight from the sidebar instead of opening the full-screen scene first.

| Key / action | Effect |
|---|---|
| any character | Edits the query in place (while the panel is focused the keyboard belongs to it: plain keys nobody consumes are swallowed by the host, so nothing leaks into the chat input) |
| `↑↓` / wheel | Move the selection (`PgUp`/`PgDn` do nothing — see below) |
| `Tab` | Switches the search scope (this repo ⇄ all sessions) — the same key the full-screen scene binds, confirmed in the same words on the status row |
| `Shift+Tab`, or a click on the `▸ (+N)` badge | Fold / unfold the session's hits |
| `↵`, or a click on the **already-selected** row | Opens the full-screen `/find`, seeded with this query, this row and this scope (reading, copying and resuming live there) |
| `Esc` | Clears the query; an empty query hands Esc back to the host (focus returns to the chat) |
| `←` `→` | Host fallback keys: cycle panels (the only plain keys the panel leaves unconsumed — `z`, digits, `[`, `]`, `+`, `-` are all taken as query characters) |
| hover / click | Moves the selection / selects; a second click on a selected row opens the scene |

- **Getting the panel into the sidebar**: a registration appends the final id to the *live* `sidePanel.panels` list, but the host then overwrites that whole list with the persisted value (its config apply at startup and on every `dsh-tui.sidePanel` write). So **registering alone is not enough to bring the panel back after a restart**: `/settings › Sidebar › Enabled panels` is a checkbox page, every registered panel gets a row (titled with the panel name, described as `Plugin panel (act1)`), and **ticking it writes `<actN>:search` into the persisted layer**, which survives restarts. To reorder or type ids by hand, use the page's "Advanced: edit raw panel list" row. Hosts from 0.15.0 on (upstream #1441) also merge registered-but-unpersisted ids back at config apply, but on this machine's 0.16.1 a tick was still needed once — **if the panel is not in the sidebar after the first install, go tick it**; that is the only reliable path.
- **To turn it off for good use `panel: false`** (the settings card's front page has that row): the plugin then registers nothing at all. Untick the row in the picker (or drop `<actN>:search` from the "Advanced" row) before/after doing so — otherwise the sidebar keeps an **unclaimed tab**: the host falls back to the name `Search` for it and renders the first enabled panel inside (host semantics, nothing the plugin can change).
- **The id is assigned by the host**: the plugin only controls the `search` segment, `actN` is a number the host hands out in activation order, so **every re-registration can change it** (turning `panel` off and on, reloading the host). Upstream had a PR renaming the namespace to `dsh-tui-find:search` (#1474) — **closed, not merged** — so `act1:search` and friends are normal on 0.13.0–0.16.x; never copy another machine's id into config or docs. After a re-registration the stale row shows up in the picker as "no panel uses this id yet" and can be deleted.
- **`PgUp`/`PgDn` do not reach the panel (0.13.0–0.16.x, every released host)**: the host's paging guard `return`s from the `(key.pageUp || key.pageDown) && fullscreen` branch — including while the panel has focus — and that `return` leaves the one `useInput` callback that owns the panel's only dispatch point (`sidePanel.handleKey`, further down in the same callback), so the panel can never see the key; the right column exists only in fullscreen, so the guard always wins. The host's own comment says those keys should belong to the focused panel; the implementation does not deliver them. The plugin keeps its branch, so moving the dispatch ahead of the guard would light it up. Paging in the full-screen scene and its reader is unaffected.
- The panel receives no `Ctrl`/`Alt` combos (the host routes those to the chat), so the only modifiers available are `Tab` and `Shift+Tab`: `Alt+E` from the scene **cannot reach the panel**, which is why folding lives on `Shift+Tab` there. The panel honors the configured time window / regex / title-only switches; **the scope can be switched from inside the panel with `Tab`**, the current scope stays on the status row, and the switch is per activation — it is never written back to config: `/find` and the shortcut entry still start from `defaultScope`, while the scene the panel hands over to carries the panel's current scope. Pinyin search (on by default) works in the panel too.
- The panel and the full-screen scene share one scanner, one in-memory index and the "one sweep at a time" rule: a panel search makes the background warm-up yield, and opening the scene aborts the panel's sweep (coming back rebuilds instantly from the warm cache). The host mounts a plugin panel only while it is in the foreground, but the query, the index and the selection are owned by the plugin: switching away and back keeps state and never resets the query. **Coming back re-runs one sweep**, so new sessions and messages just written to a live log are searchable too — unchanged logs cost a single stat, grown logs resume from the watermark, a log written within the last second pays one re-proof read and turns warm once its stamp tick closes; the list and the selected row stay put during the re-scan and are replaced wholesale when it lands.
- IME: the panel declares the terminal cursor at the query caret, so the candidate window follows the input; the declaration goes through a host-internal hook and silently degrades (candidates fall back to the chat input at the bottom) when unavailable — pinyin (`denglu` → 登录, on by default) still works there, as does the full-screen scene. While the query row is empty and the panel holds the keyboard, the row paints the cursor only: composition is invisible to the plugin, so a placeholder would be shoved around by the pre-edit.

## Search semantics

- **Indexed**: user messages, assistant text, session titles; tool-call summaries with `indexTools`, thinking text with `indexThinking`.
- **Matching**: case-insensitive substring by default (CJK-correct by construction, no segmenter); multi-term AND (double-quoted phrases keep their inner spaces, at most 16 terms); regex mode treats the whole query as ONE pattern — no term splitting.
- **Pinyin** (on by default, disable via `pinyin`): letter-only terms also match Chinese — full readings (`zhangsan` → 张三), default-reading chains (`zhongqing` → 重庆), initials (`zs` → 张三, `bjdx` → 北京大学 — one letter per character, contiguous across words); full readings match from a syllable start (a syllable tail never joins the next character's initial); polyphones use every reading, ü is written as v; a 3500-character reading table ships built in, out-of-table characters fold to themselves; regex mode is never pinyin-expanded.
- **Title-only** (`Alt+N` toggles live): session titles only, message bodies excluded — for "find that session"; untitled sessions cannot match.
- **Sub-agent sessions** (hidden by default, enable with `showSubagentSessions`): a delegated sub-agent run is its own session log, so it enters neither the list nor the search index by default — the reason is not how many there are but what they are: the model's own work, not a conversation you opened, the same posture the `/resume` browser takes when it folds them away. The discriminator is the header's `origin: subagent`: a `/rewind` fork records a parent session too but is NOT a sub-agent run, and always stays visible. The header gives them their own count (`N sessions · M sub-agent sessions hidden`). The switch only decides delivery — a filtered log is decoded and kept in the in-memory index all the same, so flipping it on re-reads nothing and flipping it back loses nothing.
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
      panel: true                # sidebar search panel switch (default on)
      caseSensitive: false       # case-sensitive matching (default off)
      regex: false               # start with regex matching on (default off; Alt+R toggles it live)
      pinyin: true               # pinyin matching (default on; letter-only terms also match Chinese via readings + initials)
      titleOnly: false           # title-only search (default off; Alt+N toggles it live)
      showSubagentSessions: false # show sub-agent sessions (default off; the /resume browser folds them away too)
      indexTools: false          # index tool-call summaries (default off)
      indexThinking: false       # index thinking text (default off)
      sessionRoot: ''            # manual session root override
      maxMessageChars: 4000      # per-message index character budget
      warmup: true               # background warm-up index (default on; off = /find scans on open)
      lang: 'auto'               # zh | en | auto (follow the host language)
      shortcut: 'alt+f'          # global entry combo: opens the scene, pressed again inside it closes it (ctrl or alt required; 'off' disables)
```

Every option except `lang` can also be edited in the TUI: `/settings` → the **dsh-tui-find (session search)** card. The card is two-level: its page keeps the everyday knobs (default scope, time window, layout, global shortcut) and three subpages — Matching, Indexing and Advanced — hold the rest (Enter opens one, Esc goes back). Booleans/selects save on the spot, text drafts confirm with Enter; the card copy follows the TUI language. Where a save lands depends on the host's settings generation: the `settings.yaml` user layer on `@deepseek-ai/dsh-settings` ≤0.1.6, the active profile's patch (`cordis.patch.yml`) on ≥0.1.7.

`lang: auto` follows the dsh-TUI language chain: `DSH_TUI_LANG` → `~/.dsh-tui/lang.json` → OS locale → zh; a `/lang` switch applies immediately.

Session root is probed in order (first hit wins): the `sessionRoot` config (exclusive override) → the `DSH_TUI_SESSION_ROOT` env var → `$DSH_HOME || ~/.dsh` + `/sessions` → `~/.dsh-tui/sessions`.

## Privacy & safety

- **Read-only end to end**: logs are opened read-only; the history lock is never touched, history is never rewritten.
- **Minimal disk footprint**: conversation content lives only in memory, never on disk. The single written file is the watermark journal `~/.dsh-tui/dsh-tui-find/watermark.json` — paths plus byte/mtime/offset metadata only, never conversation text (0700/0600 + tmp+rename atomic write; `DSH_TUI_FIND_WATERMARK=off` disables it).
- **Generation naming**: dsh logs are named per format generation (`session.jsonl`, `session.vN.jsonl`, each with a `.zstd` variant). A session directory is read from its numerically highest generation, compressed winning within one — a retired generation left behind in a migration window is never indexed.
- **Incremental decode & tolerance**: appends decode only new frames, a same-size touch decodes nothing, shrink/rewrite/encoding flips fall back to a full decode; a torn final frame is recognized per RFC 8878 and skipped — never fatal, never residue.
- **Resume needs confirmation**: resuming discards the current context; `↵` asks twice, with a loud warning while the live session is still working.

## Development

```bash
npm install          # dev dependencies
npm run build        # tsc → dist/
npm test             # pretest builds and generates fixtures, then runs the full vitest suite
npm run verify:hosts # host matrix: isolated-copy host swap, one build+test each on 0.13.0 (supported floor) and 0.16.1 (release line)
```

The suite covers frame-chain parsing, the scanner (change tokens and the stamp-tick guard, offset-watermark incremental decode, generation enumeration, sub-agent filtering), search (multi-term AND / regex / pinyin / title-only / time window / scope), the regex backtracking cost screen, the preview reader and the scene wiring (against the real host renderer, with mouse injection), the shared list model, host-generation dispatch and the settings card, and the entry combo's grammar and shadow table — see the cases under `test/` for the itemized list.

## Requirements

- dsh-TUI **≥ 0.13.0** (v0.15 community-draft plugin system): 0.13.0 is the line that introduced the right column and `ctx.tuiPanels`, and it is this plugin's minimum supported host (`peerDependencies` says the same). Pre-0.13 hosts are unsupported and have no sidebar panel
- The sidebar panel ships with that baseline (0.13.0+ always has `ctx.tuiPanels`); a host build whose seam is missing still gets the soft fallback — zero registration, zero warnings
- Version policy and verification scope: `docs/decisions/2026-10-20-host-baseline-0-13.md`
- Node `^22.19 || >=24`; Windows / macOS / Linux

## License

MIT
