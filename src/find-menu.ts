/**
 * The right-click context menu's pure model: one open menu is an anchored
 * item list with a highlight. Transitions are plain functions so the scene
 * keeps no menu-specific logic and the dispatch is unit-testable without a
 * renderer — the wiring (who opens it, who activates) lives in scene.tsx
 * and the input dispatcher. Rendering is an absolute-positioned overlay the
 * scene composes over whichever pane is up. The item type is generic so a
 * caller can carry action closures alongside the rendered vocabulary.
 *
 * @module dsh-tui-find/find-menu
 */

/** One actionable row. `id` is a stable vocabulary word; the label is the
 *  localized text the overlay renders. */
export type MenuItem = { id: 'copy-message' | 'copy-log' | 'resume'; label: string }

export type ContextMenuState<T extends MenuItem = MenuItem> = {
  /** Absolute pointer cell the menu was opened at (clamped on render). */
  anchorCol: number
  anchorRow: number
  items: readonly T[]
  highlight: number
}

/** Open a menu at the pointer: highlight starts on the first item. The
 *  caller builds the item list per row kind. */
export function openMenu<T extends MenuItem>(
  anchorCol: number,
  anchorRow: number,
  items: readonly T[],
): ContextMenuState<T> {
  return { anchorCol, anchorRow, items, highlight: 0 }
}

/** Move the highlight, clamped to the item range (a three-item menu never
 *  wraps — the list's own arrows clamp too). Out-of-range or empty menus
 *  are inert. */
export function moveHighlight<T extends MenuItem>(menu: ContextMenuState<T>, delta: number): ContextMenuState<T> {
  const last = menu.items.length - 1
  if (last < 0) return menu
  return { ...menu, highlight: Math.min(last, Math.max(0, menu.highlight + delta)) }
}

/** The highlighted item, or undefined on an empty menu. */
export function highlightedItem<T extends MenuItem>(menu: ContextMenuState<T>): T | undefined {
  return menu.items[menu.highlight]
}
