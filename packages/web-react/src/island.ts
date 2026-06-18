import type { IslandStrategy } from "@nifrajs/web/islands"
/**
 * `@nifrajs/web-react/island` — the `<Island>` marker for no-framework islands. Server-renders its
 * children inside a `<nifra-island>` element that the framework-agnostic `mountIslands` runtime
 * (`@nifrajs/web/islands`) picks up on the client. Imports only `react` (+ a type) — no `react-dom`,
 * no JSX (the package builds with plain `tsc`).
 *
 * Use on a route with `export const hydrate = false`: the page ships zero framework JS, and only the
 * island bundle (your enhancers + the tiny runtime) loads via the route's `islandScripts`. The island's
 * SSR markup is real content (works with JS off); the enhancer upgrades it when it loads.
 */
import { createElement, type ReactNode } from "react"

export interface IslandProps {
  /** Stable id matching the key in the client's `mountIslands({ <id>: enhancer })`. */
  readonly id: string
  /** Serializable props handed to the enhancer (JSON-encoded inline in `data-props`; no closures). */
  readonly props?: unknown
  /** When the enhancer runs (default `load`). `visible` (IntersectionObserver) wins TTI on long pages. */
  readonly strategy?: IslandStrategy
  /** The island's server-rendered content — real HTML, present with JS off. */
  readonly children?: ReactNode
}

/** Render a `<nifra-island>` marker around server-rendered `children`. The client enhancer mounts the
 * interactivity (see `mountIslands`). Props are JSON-encoded into `data-props`; React escapes the
 * attribute value and the client reads the decoded `dataset.props`. */
export function Island({ id, props, strategy = "load", children }: IslandProps): ReactNode {
  return createElement(
    "nifra-island",
    {
      "data-id": id,
      "data-strategy": strategy,
      // Omit `data-props` entirely when there are no props (keeps markup minimal + parse a no-op).
      ...(props === undefined ? {} : { "data-props": JSON.stringify(props) }),
    },
    children,
  )
}
