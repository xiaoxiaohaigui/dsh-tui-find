/**
 * Vendored type surface of `@deepseek-ai/dsh-settings`, exact to the two
 * members the plugin touches. The real package is a host peer that ships
 * with the dsh profile deployment but is not resolvable from the plugin's
 * own tree — the runtime import in settings.ts is dynamic and contained,
 * and this declaration only gives it a shape.
 */

declare module '@deepseek-ai/dsh-settings' {
  /**
   * Build the namespaced settings-service key for a plugin namespace
   * (the host calls `settingsNamespace('dsh-tui')` for its own card).
   */
  export function settingsNamespace(name: string): unknown
}
