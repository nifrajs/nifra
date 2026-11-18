import type { RenderProps } from "@nifrajs/web"
import { type Accessor, type Context, createContext } from "solid-js"

// A null default, not none: a context made without one throws when read outside a provider, and a
// route component is read off-tree by `useSearch`/`useMatches` (a unit test, a story, a fallback).

/** Shared provider identities across the Bun server and Vite's SSR module graph. */
const SEARCH_CONTEXT_SLOT = Symbol.for("nifra.web-solid.search-context")
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The namespaced Symbol.for key shares one matching Solid Context across Bun and Vite's duplicate module graphs in this SSR process.
const searchContextSlot = globalThis as {
  [SEARCH_CONTEXT_SLOT]?: Context<Accessor<Record<string, unknown>> | null>
}
export const SearchContext =
  searchContextSlot[SEARCH_CONTEXT_SLOT] ??
  createContext<Accessor<Record<string, unknown>> | null>(null)
searchContextSlot[SEARCH_CONTEXT_SLOT] = SearchContext

/** Props for the composed route chain; a global singleton for the same reason as SearchContext. */
const PROPS_CONTEXT_SLOT = Symbol.for("nifra.web-solid.props-context")
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The namespaced Symbol.for key shares one matching Solid Context across Bun and Vite's duplicate module graphs in this SSR process.
const propsContextSlot = globalThis as { [PROPS_CONTEXT_SLOT]?: Context<RenderProps | null> }
export const RenderPropsContext =
  propsContextSlot[PROPS_CONTEXT_SLOT] ?? createContext<RenderProps | null>(null)
propsContextSlot[PROPS_CONTEXT_SLOT] = RenderPropsContext
