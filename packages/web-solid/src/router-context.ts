import type { RenderProps } from "@nifrajs/web"
import { type Accessor, type Context, createContext } from "solid-js"

/** Shared provider identities across the Bun server and Vite's SSR module graph. */
const SEARCH_CONTEXT_SLOT = Symbol.for("nifra.web-solid.search-context")
const searchContextSlot = globalThis as {
  [SEARCH_CONTEXT_SLOT]?: Context<Accessor<Record<string, unknown>> | undefined>
}
export const SearchContext =
  searchContextSlot[SEARCH_CONTEXT_SLOT] ?? createContext<Accessor<Record<string, unknown>>>()
searchContextSlot[SEARCH_CONTEXT_SLOT] = SearchContext

/** Props for the composed route chain; a global singleton for the same reason as SearchContext. */
const PROPS_CONTEXT_SLOT = Symbol.for("nifra.web-solid.props-context")
const propsContextSlot = globalThis as { [PROPS_CONTEXT_SLOT]?: Context<RenderProps | undefined> }
export const RenderPropsContext =
  propsContextSlot[PROPS_CONTEXT_SLOT] ?? createContext<RenderProps>()
propsContextSlot[PROPS_CONTEXT_SLOT] = RenderPropsContext
