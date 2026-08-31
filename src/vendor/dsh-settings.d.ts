/**
 * Legacy type shim for `@deepseek-ai/dsh-settings`. The real package is a
 * host peer that ships with the dsh profile deployment but is not required by
 * this plugin's own tree. Namespace registration now passes the raw string
 * through the structural `ctx.settings` seam, so this helper remains only for
 * older consumers that still import it.
 */

declare module '@deepseek-ai/dsh-settings' {
  /**
   * Build the namespaced settings-service key for a plugin namespace
   * (the host calls `settingsNamespace('dsh-tui')` for its own card).
   */
  export function settingsNamespace(name: string): unknown
}
