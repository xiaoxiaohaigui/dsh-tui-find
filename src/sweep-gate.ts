/**
 * The single-sweep discipline, made explicit: the plugin's scanner has one
 * in-flight decode cache and one watermark journal, so two sweeps at the same
 * time pay the work twice and fight over the same cache entries (the second
 * writer of a file's entry wins; both results are correct, the work is not).
 *
 * Until the sidebar panel arrived there was one background sweeper (warmup)
 * and one foreground sweeper (the scene), and "the scene supersedes" was
 * enough: the warm-up checked `isSceneOpen()` at start and on every per-file
 * progress tick. The panel is a SECOND background-ish sweeper that can start
 * at any moment the user is looking at the sidebar — including inside the
 * warm-up's 10s window — so precedence needs a name:
 *
 * - **panel > warmup**: a sweep the user is waiting on (they typed a query)
 *   preempts the opportunistic warm-up. The warm-up notices at its next tick
 *   and settles to idle; the panel takes the cache as it finds it.
 * - **warmup > nothing**: a warm-up never preempts the panel; when the panel
 *   holds the slot the warm-up gives up for this activation (its whole purpose
 *   — a warm cache for the first search — is being served by the panel's own
 *   sweep).
 * - **the scene is above the gate**: it always wins, because the scene is the
 *   user's explicit full-screen action. Gate holders abort on the scene probe
 *   they were already given (`isSceneOpen`), so the gate does not model it.
 *
 * A claim is a generation token, not a lock: it is never awaited, never
 * blocks, and its owner learns it lost by polling {@link SweepClaim.lost} at
 * the yield points it already has (the scan's progress/arrival callbacks).
 * That shape is deliberate — the alternative (a queue) would make a background
 * warm-up able to delay a keystroke-visible search.
 *
 * @module dsh-tui-find/sweep-gate
 */

/** Who is asking for the scanner. Order in {@link SWEEP_PRIORITY} is the
 *  whole policy; the type is closed so a new sweeper must state its rank. */
export type SweepOwner = 'warmup' | 'panel'

/** Higher wins. `panel` is the user-facing search, `warmup` is opportunistic. */
const SWEEP_PRIORITY: Record<SweepOwner, number> = { warmup: 0, panel: 1 }

/** One owner's hold on the sweep slot: poll {@link lost} at yield points and
 *  always {@link release} when the sweep settles. */
export interface SweepClaim {
  /** Whether another owner has taken the slot since this claim was issued. */
  lost(): boolean
  /** Give the slot up. Idempotent; a stale claim cannot release its
   *  successor's hold (the generation check). */
  release(): void
}

/**
 * The slot itself. One instance per plugin activation (main.tsx), shared by
 * the warm-up driver and the panel driver; a per-activation instance is what
 * makes a plugin reload start from a clean slate without any global state.
 */
export class SweepGate {
  private owner: SweepOwner | undefined
  private generation = 0

  /**
   * Ask for the slot.
   *
   * @returns a claim, or `undefined` when a STRICTLY higher-priority owner
   *   holds it — the caller must then skip its sweep entirely (it will be
   *   offered the slot again only if it asks again later).
   */
  claim(owner: SweepOwner): SweepClaim | undefined {
    const held = this.owner
    if (held !== undefined && SWEEP_PRIORITY[held] > SWEEP_PRIORITY[owner]) return undefined
    // Same owner or a preemptable one: taking the slot bumps the generation,
    // which is exactly how the previous holder discovers it lost.
    const generation = ++this.generation
    this.owner = owner
    return {
      lost: () => this.generation !== generation,
      release: () => {
        if (this.generation !== generation) return
        this.generation += 1
        this.owner = undefined
      },
    }
  }

  /** The current owner, for tests and diagnostics. */
  current(): SweepOwner | undefined {
    return this.owner
  }
}
