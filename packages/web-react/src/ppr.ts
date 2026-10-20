import { createElement, type ReactNode, useEffect, useRef } from "react"
import { hydrateRoot, type Root } from "react-dom/client"
import { Await } from "./await.ts"

/** One hole's fill, as the PPR runtime keeps it. */
interface HoleFill {
  readonly props?: unknown
  readonly error: boolean
}

interface PprRuntime {
  get(name: string): HoleFill | undefined
  subscribe(name: string, callback: (fill: HoleFill) => void): () => void
}

/** The runtime the shell's inline script defines, when this document has one. */
const pprRuntime = (): PprRuntime | undefined => {
  const runtime: unknown = Reflect.get(globalThis, "__nifraPpr")
  return typeof runtime === "function" && "get" in runtime && "subscribe" in runtime
    ? // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the shell's constant inline runtime defines exactly this shape (internal/ppr/runtime.ts in @nifrajs/web).
      (runtime as PprRuntime)
    : undefined
}

/** The fields of a route's boundary declaration a hole renders from. */
export interface HoleDefinition<Data> {
  readonly name: string
  readonly render: (data: Data) => ReactNode
  readonly fallback?: ReactNode
  readonly interactive?: boolean
}

/** The slice of a boundary state a hole reads: `ppr` marks a hole the shared shell left open. */
interface HoleState {
  readonly status: "unresolved" | "pending" | "ready" | "error"
  readonly data?: unknown
  readonly ppr?: true
}

export interface HoleProps<Data> {
  readonly of: HoleDefinition<Data>
  readonly state: HoleState | undefined
  /** Shown when the hole's loader failed. Default: nothing. */
  readonly error?: ReactNode
}

const EMPTY_HTML = { __html: "" }

/**
 * Experimental: one `dynamic` boundary of a partially prerendered page.
 *
 * In a shared shell the hole is an empty host React never fills or diffs: the PPR runtime puts the
 * server's HTML into it, and an interactive hole then hydrates as its own root from the frame's props.
 * After a client navigation the hole renders like any streamed boundary.
 */
export function Hole<Data>(props: HoleProps<Data>): ReactNode {
  const { of: hole, state } = props
  const host = useRef<HTMLDivElement>(null)
  const open = state?.ppr === true
  const interactive = hole.interactive === true
  const { name, render } = hole
  useEffect(() => {
    const element = host.current
    const runtime = pprRuntime()
    if (!open || !interactive || element === null || runtime === undefined) return
    let root: Root | undefined
    const hydrate = (fill: HoleFill): void => {
      if (fill.error || root !== undefined) return
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the server framed these props from this hole's own loader, through its output guard.
      root = hydrateRoot(element, render(fill.props as Data), {
        identifierPrefix: `nifra-${name}-`,
      })
    }
    const now = runtime.get(name)
    const unsubscribe = now === undefined ? runtime.subscribe(name, hydrate) : undefined
    if (now !== undefined) hydrate(now)
    return () => {
      unsubscribe?.()
      // Unmounting a root while the parent commits warns in React; the next task is outside it.
      const leaving = root
      if (leaving !== undefined) setTimeout(() => leaving.unmount(), 0)
    }
  }, [open, interactive, name, render])
  if (open) {
    return createElement("div", {
      ref: host,
      "data-nifra-hole": name,
      "aria-busy": "true",
      // biome-ignore lint/security/noDangerouslySetInnerHtml: always empty; it only stops React from reconciling the host the PPR runtime fills.
      dangerouslySetInnerHTML: EMPTY_HTML,
      suppressHydrationWarning: true,
    })
  }
  if (state === undefined) return hole.fallback ?? null
  if (state.status === "error") return props.error ?? null
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a ready state carries this boundary's loader output, through its output guard.
  if (state.status === "ready") return render(state.data as Data)
  // A streamed hole's data is its deferred loader output, whatever status the payload names.
  if (state.data === undefined) return hole.fallback ?? null
  return Await<Data>({
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a pending streamed state carries this boundary's deferred loader output.
    resolve: state.data as Data,
    fallback: hole.fallback ?? null,
    errorFallback: () => props.error ?? null,
    children: render,
  })
}
