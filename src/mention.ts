/**
 * The composer's `@` completion provider (`ctx.tuiMentions`, dsh-TUI 0.20.1+):
 * type `@` in the prompt box and the plugin answers with what its own index
 * already holds, so "I found it in /find, now say something about it" no
 * longer needs a copy-paste round trip.
 *
 * ## What this seam is (and is not)
 *
 * A chosen row REPLACES the typed `@query` with plain text; nothing is
 * resolved at submit time (the host is explicit: no tool is invoked, no
 * attachment is staged). So a row's `insertText` has to be ordinary words the
 * user could have typed — never a protocol, never an excerpt of the
 * conversation. The shapes that would be tempting, and are deliberately
 * absent:
 *
 * - no `@` token (the host DROPS such a row at ingress, `extractMentions`);
 * - no body text copied out of the matched message — that would turn a
 *   completion popup into a channel for pulling arbitrary conversation text
 *   into a prompt, and the host collapses whitespace and truncates anyway, so
 *   the "quote" would arrive mangled;
 * - no instruction that presumes a capability the agent may not have. The row
 *   states what the user is referring to and stops there; the user appends
 *   whatever they actually want done.
 *
 * ## Why no work happens per keystroke
 *
 * The host gives every provider 300 ms per query, aborts it when the user
 * types on, and asks every registered provider on every keystroke of the
 * token. A cold decode there would blow the budget and contribute nothing, so
 * {@link MentionIndex} only ever answers from an in-memory list. That list is
 * normally handed over by a sweep somebody else already ran — the background
 * warm-up, or the scene's/panel's sweep, all on the same `SessionScanner` —
 * and only when nobody has swept yet does this module start one pass of its
 * own in the background. The first cold answer is therefore empty on purpose:
 * an empty popup is exactly the pre-seam behaviour, and the next keystroke
 * finds the list ready.
 *
 * ## Posture
 *
 * Structural soft probe, like every other seam here: the dev type baseline
 * (0.9.3) cannot declare a service it does not ship, the seam does not exist
 * before 0.20.1, and upstream grades it EXPERIMENTAL. Absent -> nothing
 * registers, nothing warns, and the plugin behaves exactly as it did before
 * this module existed.
 *
 * @module dsh-tui-find/mention
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.js'
import { t } from './i18n.js'
import { searchSessions, type SearchOptions, type SessionHit } from './core/search.js'
import type { ScannedSession, SessionScanner } from './core/scan.js'
import { buildScanOptions } from './find-sweep.js'
import { registerSeamWithRetry, whenSeamMounted } from './seam.js'
import { displayWidth, truncateWidth } from './width.js'

/** The provider id (host grammar: `^[a-z][a-z0-9_-]*$`). */
export const MENTION_PROVIDER_ID = 'dsh-tui-find'

/** Column and character budgets, mirroring the host's own
 *  `MENTION_PROVIDER_LIMITS`. The host sanitizes at ingress regardless; the
 *  plugin cuts first so its intent is visible in its own code and testable
 *  without reaching into the host package. */
export const MENTION_LABEL_CELLS = 80
export const MENTION_DETAIL_CELLS = 40
export const MENTION_INSERT_CHARS = 200
/** The host takes at most 50 rows per provider per query; stop there rather
 *  than searching a list nobody can show. */
export const MENTION_MAX_ITEMS = 50
/** How many characters of the session id ride the row detail. Enough to tell
 *  two same-titled sessions apart, short enough not to crowd out the hit
 *  count (R-221). */
export const MENTION_ID_CHARS = 8

/** One completion row; the shape the host validates (`TuiMentionItem`). */
export interface MentionItem {
  readonly label: string
  readonly detail?: string
  readonly insertText: string
}

/** The provider the host calls. */
export interface MentionProvider {
  readonly id: string
  readonly title: string
  complete(query: string, signal: AbortSignal): readonly MentionItem[] | Promise<readonly MentionItem[]>
}

/** The probed slice of `TuiMentionRuntime` — `register` only, so an older or
 *  drifted service degrades to the documented no-op instead of throwing. */
export interface MentionSurface {
  register?(provider: MentionProvider): (() => void) | undefined
}

/** What the provider needs from the plugin. */
export interface MentionWiring {
  /** The plugin-scoped scanner: the same instance the warm-up, the scene and
   *  the sidebar panel sweep with, so a mention lookup never pays a decode a
   *  surface already did. */
  readonly scanner: SessionScanner
  /** Live config, re-read per query (a settings edit changes both what the
   *  index holds and how a query matches). */
  readonly config: () => ResolvedConfig
  /** A full-screen scene runs its own sweep on mount; a background pass here
   *  would be a second decode nobody asked for. */
  readonly isSceneOpen: () => boolean
}

/**
 * The index behind the provider: the last sweep's list plus at most one
 * background pass this module may start on its own.
 *
 * Why that fallback exists: the warm-up is the intended builder, but it is
 * (a) off under `warmup: false`, (b) skippable when the sidebar panel holds
 * the sweep gate at the 10 s mark, and (c) still inside its quiet window
 * while a user can already type `@`. Without a fallback the provider would
 * answer nothing for the whole session on those paths.
 *
 * The pass deliberately takes no `SweepGate` slot: this is not a user-facing
 * search, so it must not preempt the panel or the warm-up. The price is one
 * possible overlapping decode on a cold process's first `@`, bounded to once
 * per activation (a landed pass is authoritative even when empty) and never
 * doubled while a pass is in flight. Cache and watermark writes stay correct
 * under overlap: two sweeps compute the same entries and the second writer
 * wins.
 */
export class MentionIndex {
  private sessions: readonly ScannedSession[] = []
  private landed = false
  private running: AbortController | undefined
  /** The index-shape options the current list was built with. A settings edit
   *  that changes which documents exist (tool calls, thinking, sub-agents, the
   *  per-message budget, the session root) makes the list stale; the next
   *  query starts one refresh and keeps serving the old list until it lands. */
  private optionsKey: string | undefined

  constructor(private readonly wiring: MentionWiring) {}

  /** The list available right now (empty before the first sweep lands). */
  snapshot(): readonly ScannedSession[] {
    return this.sessions
  }

  /** Whether a sweep ever landed — an empty library is a legitimate answer,
   *  and must not make the provider retry on every keystroke. */
  isReady(): boolean {
    return this.landed
  }

  /** Adopt a settled scan. Public so a surface that already swept can hand its
   *  list over instead of making this module buy a second pass.
   *
   *  @param optionsKey - The index-shape key the scan ran under. It must be
   *    the one from when the pass STARTED, never a fresh read: a settings edit
   *    that lands while the pass is in flight would otherwise be recorded as
   *    already applied, and the stale list would be served for the whole
   *    session (the caller passes what it scanned with; the default re-reads
   *    for adopters that had no pass of their own). */
  adopt(sessions: readonly ScannedSession[], optionsKey?: string): void {
    this.sessions = sessions
    this.landed = true
    this.optionsKey = optionsKey ?? mentionOptionsKey(this.wiring.config())
  }

  /** Start the one background pass this index may run, if one is warranted.
   *  Never throws and never awaits: the caller is a 300 ms completion call. */
  ensure(): void {
    if (this.running !== undefined) return
    const config = this.wiring.config()
    const key = mentionOptionsKey(config)
    if (this.landed && this.optionsKey === key) return
    if (this.wiring.isSceneOpen()) return
    const controller = new AbortController()
    this.running = controller
    void this.wiring.scanner
      .scan(
        buildScanOptions(config, {
          signal: controller.signal,
          onProgress: () => {},
          onSession: () => {},
        }),
      )
      .then(sessions => {
        if (!controller.signal.aborted) this.adopt(sessions, key)
      })
      .catch(() => {
        // Additive surface: a failed pass leaves the popup showing file
        // completions only, exactly as before this module existed. The next
        // query retries; by then the warm-up or a surface sweep has usually
        // won the race anyway.
      })
      .finally(() => {
        if (this.running === controller) this.running = undefined
      })
  }

  /** Plugin dispose: nothing outlives the activation. */
  dispose(): void {
    this.running?.abort()
    this.running = undefined
  }
}

/** Which documents the index holds — the knobs that decide whether a landed
 *  list is still the answer a query expects. Query-time knobs (case
 *  sensitivity, pinyin, title-only, scope) are NOT in here: they are applied
 *  per call, over the same list. */
export function mentionOptionsKey(config: ResolvedConfig): string {
  return [
    config.indexTools ? 'tools' : '',
    config.indexThinking ? 'thinking' : '',
    config.showSubagentSessions ? 'subagents' : '',
    String(config.maxMessageChars),
    config.sessionRoot ?? '',
  ].join('|')
}

/**
 * The rows one query answers with: pure and synchronous over an
 * already-scanned list, so the behaviour that matters (what a row says, what
 * it inserts, how the budget is spent) is testable without a scanner, a
 * settings service or a host.
 *
 * @param sessions - The index snapshot.
 * @param query - The text after `@`; empty when the token was just typed.
 * @param options - Query-time search options.
 */
export function buildMentionItems(
  sessions: readonly ScannedSession[],
  query: string,
  options: SearchOptions,
): MentionItem[] {
  const trimmed = query.trim()
  // A bare '@' lists nothing: the popup would otherwise open with fifty
  // arbitrary sessions before the user has said what they are after.
  if (trimmed.length === 0 || sessions.length === 0) return []
  const items: MentionItem[] = []
  for (const hit of searchSessions(sessions, trimmed, options)) {
    if (items.length >= MENTION_MAX_ITEMS) break
    items.push(itemFor(hit, trimmed))
  }
  return items
}

/**
 * Characters that carry meaning to somebody downstream must not ride a row
 * verbatim (R-219). `@` is the host mention trigger: `normalizeItems` runs
 * `extractMentions(insertText)` and DROPS the whole row when it finds one, so
 * a session titled "ask @alice about auth" would silently lose its
 * completion. The fullwidth form keeps the sentence readable and inert.
 */
function neutralizeAtSigns(text: string): string {
  return text.split('@').join('\uFF20')
}

/**
 * Cut a string to at most `max` UTF-16 code units — the unit a host counts
 * for fenced lengths (R-220).
 *
 * `truncateWidth` measures terminal COLUMNS, which is right for a painted row
 * and wrong for `insertText.length`: wide and astral characters cost two
 * cells but one or two code units, so a column-budgeted sentence can exceed
 * the host character cap and be dropped wholesale. The ellipsis is inside
 * the budget, matching {@link truncateWidth}.
 */
function truncateChars(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  // Accumulate CODE POINTS (never split a surrogate pair) while measuring
  // UTF-16 units (the unit the host counts), and reserve one for the ellipsis.
  let out = ''
  let used = 0
  for (const char of text) {
    if (used + char.length > max - 1) break
    out += char
    used += char.length
  }
  return out + '\u2026'
}

/** One session row: the conversation name (with its short id), how many
 *  places matched, and the sentence that continues from it. */
function itemFor(hit: SessionHit, query: string): MentionItem {
  const title = (hit.session.title ?? '').trim()
  // R-221: the row has to be ADDRESSABLE. Two sessions can share a title, and
  // the host dedupes rows on (label, insertText) — an identical pair collapses
  // and the second session becomes unreachable through @. The id therefore
  // rides the LABEL, which is the field the user reads to pick a row; the
  // inserted sentence stays clean because an id is noise to the model (see
  // the i18n entry for mention-insert).
  const label = labelFor(hit, title)
  // The SENTENCE names the session by its title, never by the label: the label
  // carries the short id for the popup's benefit, and an id inside a prompt is
  // noise the model cannot resolve (see the i18n entry for mention-insert).
  // Both halves are neutralized and the sentence is bounded in CHARACTERS,
  // the unit the host caps (R-220).
  const sentence = t('mention-insert', {
    query: neutralizeAtSigns(query),
    title: neutralizeAtSigns(truncateWidth(title.length > 0 ? title : hit.session.id, MENTION_LABEL_CELLS)),
  })
  return { label, detail: detailFor(hit), insertText: truncateChars(sentence, MENTION_INSERT_CHARS) }
}

/**
 * `<title> <id>` cut to the host label budget.
 *
 * The title is truncated FIRST, against the budget minus the suffix — appending
 * the id after a full-width truncation would push the label past
 * MENTION_LABEL_CELLS, the host would cut the tail, and the two same-titled
 * sessions would collapse back into one row (R-221). Neutralization happens
 * last so a replaced sign cannot change the measurement.
 */
function labelFor(hit: SessionHit, title: string): string {
  const suffix = ` [${shortId(hit.session.id)}]`
  // An untitled session's label IS its id — appending the suffix would print
  // it twice ("sess-x [sess-x]").
  if (title.length === 0) {
    return neutralizeAtSigns(truncateWidth(hit.session.id, MENTION_LABEL_CELLS))
  }
  const room = Math.max(1, MENTION_LABEL_CELLS - displayWidth(suffix))
  return neutralizeAtSigns(truncateWidth(title, room) + suffix)
}

/** The short id that keeps two same-titled sessions distinct (R-221). */
function shortId(id: string): string {
  return id.length > MENTION_ID_CHARS ? id.slice(0, MENTION_ID_CHARS) : id
}

/** `<n> hits` — the row's dim trailing hint. The identity rides the label and
 *  the inserted sentence, not here: the host's dedupe key is (label,
 *  insertText), so a difference in `detail` alone would not make two rows
 *  distinct (R-221). */
function detailFor(hit: SessionHit): string {
  return truncateWidth(neutralizeAtSigns(t('mention-detail', { n: hit.total })), MENTION_DETAIL_CELLS)
}

/**
 * The provider object handed to the host.
 *
 * `complete` never throws and never rejects. The host contains a failing
 * provider anyway, but a throw here would also lose the rows this same call
 * already had in hand, and an empty popup is always a valid answer.
 */
export function createMentionProvider(wiring: MentionWiring, index: MentionIndex): MentionProvider {
  return {
    id: MENTION_PROVIDER_ID,
    // Read once at registration: the host freezes the descriptor it renders,
    // so the title follows the plugin language for this activation (the
    // panel-title rule).
    get title(): string {
      return t('mention-provider-title')
    },
    complete(query: string, signal: AbortSignal): readonly MentionItem[] {
      try {
        if (signal.aborted) return []
        const config = wiring.config()
        // `mention: false` means the row was RELEASED from the host (see
        // MentionHandle), so this branch is the belt to that suspenders: a
        // config edit that lands between the settings write and the holder's
        // sync must not answer, and must not spend a scan finding that out.
        if (!config.mention) return []
        index.ensure()
        return buildMentionItems(index.snapshot(), query, {
          // ALWAYS 'all', never `config.defaultScope`. The composer gives the
          // provider no channel, no cwd and no session context, so a repo scope
          // would be a scope with nothing to compare against — and the kernel's
          // documented answer to that is "match nothing", i.e. a popup that is
          // silently always empty. Searching every session is the only scope
          // this seam can honestly honour; the row's detail carries the session
          // id (R-221), which is the disambiguation a cwd would have given.
          scope: 'all',
          ...(config.caseSensitive ? { caseSensitive: true } : {}),
          ...(config.pinyin ? { pinyin: true } : {}),
          ...(config.titleOnly ? { titleOnly: true } : {}),
          // R-225: the regex mode is a live scene knob, and honouring it here
          // costs one flag. An uncompilable pattern matches nothing, which is
          // the same answer the kernel gives the scene — the scene surfaces the
          // rejection, a completion popup just shows no rows.
          ...(config.regex ? { regex: true } : {}),
        })
      } catch {
        // Untrusted-input posture (the host's own rule for this seam): one
        // bad row must never cost the popup its other rows.
        return []
      }
    },
  }
}

/**
 * One provider registration held by the plugin: the host disposer, the index
 * behind it, and the single `dispose()` that lets go of BOTH.
 *
 * R-214: the two are easy to confuse — `MentionIndex.dispose()` only aborts a
 * background scan, it does not release the host registration. Handing the
 * index back as if it were the registration handle made `mention: false` a
 * no-op that still left the provider mounted (and the next `true` collided
 * with `already registered`). This holder is the type that makes the mistake
 * impossible: its `dispose` is the one the row switch and the activation
 * effect both call.
 */
export interface MentionHandle {
  /** Release the host registration and stop the background pass. */
  dispose(): void
  /** The index this registration answers from (tests and diagnostics). */
  readonly index: MentionIndex
}

/**
 * Register the provider when the host carries the seam (dsh-TUI 0.20.1+), and
 * do nothing anywhere else.
 *
 * Two failure shapes, handled the way every other seam in this plugin handles
 * them:
 *
 * - **The service mounts later.** The profile interleaves its rows, so this
 *   apply can beat the `dsh-tui-mentions` row. The shared late-mount poll
 *   covers it; its give-up is SILENCED (`quiet`) because a host without this
 *   seam is the documented no-op posture, not a degradation (the seam is
 *   0.20.1+ while the plugin floor is 0.13.0).
 * - **The host refuses THIS attempt.** R-215: `register` reaches
 *   `requirePluginCaller` / `activationFiber` before `admit`, so the cold-boot
 *   liveness window rejects it with a TRANSIENT "requires a live activation"
 *   error — exactly the race `registerSeamWithRetry` exists for, and the one
 *   the panel and the scene already retry. A single failed attempt would cost
 *   the whole session of `@` completion silently, so the retry is here too.
 *   The two permanent refusals are separated: a passive-shadow denial is a
 *   designed no-op (info, like the panel), and an exhausted retry budget ends
 *   in one warning.
 */
export function registerMentionProvider(ctx: Context, wiring: MentionWiring): MentionHandle {
  const index = new MentionIndex(wiring)
  let release: (() => void) | undefined
  let released = false
  const register = (): (() => void) => {
    const surface = ctx.get('tuiMentions', false) as MentionSurface | undefined
    if (surface === undefined || typeof surface.register !== 'function') {
      throw new Error('tuiMentions service is not mounted')
    }
    const dispose = surface.register(createMentionProvider(wiring, index))
    if (dispose === undefined) throw new Error('tuiMentions.register refused the find provider')
    return dispose
  }
  const attach = (dispose: () => void): void => {
    // The row can be switched off while a retry is still in flight: honour
    // that instead of leaking a provider nothing will ever release.
    if (released) {
      dispose()
      return
    }
    release = dispose
    ctx.effect(() => dispose)
  }
  whenSeamMounted(
    ctx,
    '@ mention provider',
    () => {
      const surface = ctx.get('tuiMentions', false) as MentionSurface | undefined
      return surface !== undefined && typeof surface.register === 'function' ? surface : undefined
    },
    () => {
      try {
        attach(register())
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        // A shadow-mode run denies this capability outright: permanent by
        // construction, not the cold-boot race the retry budget is for.
        if (detail.includes('shadow policy denies')) {
          ctx.logger.info(`dsh-tui-find: @ mention provider unavailable (${detail})`)
          return
        }
        registerSeamWithRetry(ctx, '@ mention provider', register, attach, error)
      }
    },
    { quiet: true },
  )
  return {
    index,
    dispose: () => {
      if (released) return
      released = true
      const dispose = release
      release = undefined
      dispose?.()
      // The index goes with it: a switched-off row must not keep a
      // background scan alive.
      index.dispose()
    },
  }
}

/**
 * Keep the host registration in step with the `mention` config row.
 *
 * "Off" means the provider is RELEASED from the host, not merely muted: the
 * host persists nothing about mention providers (they live in a runtime map
 * keyed by activation), so releasing and re-registering costs nothing and is
 * the only version of the row a user can observe — a mounted provider that
 * quietly answers nothing is still a provider the host asks on every `@`
 * keystroke (R-214). The handle contract is what makes that work: see
 * {@link MentionHandle}.
 */
export class MentionRegistration {
  private handle: { dispose(): void } | undefined
  private enabled = true

  /**
   * @param register - starts one registration attempt; returns the handle that
   *   releases the provider (and the index it answers from).
   */
  constructor(private readonly register: () => MentionHandle) {}

  /** Register when enabled (idempotent), release the provider when not. */
  sync(enabled: boolean): void {
    this.enabled = enabled
    if (enabled) {
      this.handle ??= this.register()
      return
    }
    this.handle?.dispose()
    this.handle = undefined
  }

  /** Whether the row currently lets the provider answer. */
  isEnabled(): boolean {
    return this.enabled
  }

  /** Plugin dispose: no registration outlives the activation. */
  dispose(): void {
    this.handle?.dispose()
    this.handle = undefined
  }
}