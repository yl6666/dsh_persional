/**
 * Structural types for the browser-side DSH services this plugin consumes
 * (slots, the right-sidebar tab registry, navigation). Mirrors the shapes
 * from the reference implementations (ui-sidebar-right, ui-sidebar-textpreview);
 * the real services satisfy them structurally inside the Web composition.
 * @module dsh-repo-board/client
 */

import type { ReactElement } from 'react'

/** Minimal browser cordis context: effects and the optional services. */
export interface ClientContext {
  effect(callback: () => void | (() => void), label?: string): () => void
}

/** One keyed or ordered seat registration. */
export interface SlotRegistration {
  readonly name: string
  readonly key?: string
  readonly id?: string
  readonly order?: number
  readonly locale?: string
  readonly inject?: (sessionId: unknown) => unknown
  readonly store?: unknown
}

/** A React component the slot runtime renders. */
export type SlotComponent = (props: never) => ReactElement | null

/** The renderer-owned slot registry. */
export interface SlotsServiceLike {
  inject(seat: string, factory: () => () => void): () => void
  register(options: SlotRegistration, component: SlotComponent | ((props: unknown) => ReactElement | null)): () => void
}

/** Stage one of a tab-type registration. */
export interface SidebarRightTabDefinition {
  readonly id: string
  readonly kind: string
  readonly patterns: readonly string[]
  readonly priority: 'fallback' | 'preferred' | 'exclusive'
  readonly canOpen: (address: string) => boolean
  readonly title: (address: string) => string
}

/** The right-sidebar tab-type registry. */
export interface SidebarRightTabsLike {
  register(definition: SidebarRightTabDefinition): () => void
}

/** The right-sidebar navigation face. */
export interface SidebarRightLike {
  openResource(address: string, options?: Record<string, unknown>): void
}
