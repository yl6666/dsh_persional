/**
 * Browser half of dsh-repo-board: the board tab and its launcher
 * (docs/product-design.md 7, 14.1).
 *
 * Registers through the Sidebar's public two-stage path (the
 * ui-sidebar-textpreview template): the `repo-board` tab type claims
 * `dsh-resource://repo-board/**` addresses, and the body registers into the
 * keyed `sidebar.right.pane.tab` seat. A launcher button in the conversation
 * input dock navigates to the board. All host services are consumed through
 * hand-rolled structural types (dsh/types.ts) so this package keeps only
 * the cordis peer dependency; inside the shipped Web composition the real
 * services satisfy them structurally.
 * @module dsh-repo-board/client
 */

import type { ClientContext, SidebarRightLike, SidebarRightTabsLike, SlotsServiceLike } from './host.ts'
import { BoardPanel } from './Board.tsx'
import { BoardLauncherButton } from './LauncherButton.tsx'

/** The tab kind this package owns. */
export const BOARD_KIND = 'repo-board'

/** This implementation's identity: the key its body registers under. */
export const BOARD_ID = 'dsh-repo-board/client'

/** The resource address that opens the board. */
export const BOARD_ADDRESS = 'dsh-resource://repo-board/graph'

/** Required browser services: the slot registry, the tab registry, and navigation. */
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight']

/**
 * Client plugin body: register the tab type, its body, and the dock launcher.
 * @param ctx - client root context carrying the slot and tab services.
 */
export function apply(ctx: ClientContext): void {
  const tabs = (ctx as { sidebarRightTabs?: SidebarRightTabsLike }).sidebarRightTabs
  const slots = (ctx as { slots?: SlotsServiceLike }).slots
  const sidebarRight = (ctx as { sidebarRight?: SidebarRightLike }).sidebarRight
  if (tabs === undefined || slots === undefined || sidebarRight === undefined) return

  ctx.effect(() => tabs.register({
    id: BOARD_ID,
    kind: BOARD_KIND,
    patterns: ['dsh-resource://repo-board/**'],
    priority: 'fallback',
    canOpen: (address: string) => address.startsWith('dsh-resource://repo-board/'),
    title: () => '多仓看板',
  }), 'repo-board: tab type')

  ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
    { name: 'sidebar.right.pane.tab', key: BOARD_ID, inject: () => ({}) },
    BoardPanel,
  )), 'repo-board: board body')

  ctx.effect(() => slots.inject('conversation.input.dock', () => slots.register(
    {
      name: 'conversation.input.dock',
      id: 'repo-board',
      order: 90,
      inject: () => ({ open: () => sidebarRight.openResource(BOARD_ADDRESS) }),
    },
    BoardLauncherButton,
  )), 'repo-board: launcher')
}
