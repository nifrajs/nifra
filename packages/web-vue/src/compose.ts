import type { RenderProps } from "@nifrajs/web"
import { type Component, h, type VNode } from "vue"
import { RenderPropsProvider, SearchProvider } from "./router.ts"

// Frozen empty search so a render with no search context has a stable provider value.
const EMPTY_SEARCH: Readonly<Record<string, unknown>> = Object.freeze({})

// What the router hooks read through the provider. A page that does not declare one would get it as an
// attribute on its root element, and Vue renders an object-valued attribute on the client
// ("[object Object]") but not on the server - a hydration mismatch.
const ROUTER_PROPS = ["path", "search", "params"] as const

function declaredProps(component: unknown): ReadonlySet<string> {
  const declared = (component as { props?: unknown } | null)?.props
  if (Array.isArray(declared)) return new Set(declared as string[])
  return new Set(typeof declared === "object" && declared !== null ? Object.keys(declared) : [])
}

/**
 * Fold a layout chain (outermost layout → page) into a single Vue VNode: the page (innermost)
 * receives `props` (the loader data); each layout wraps the child via its default slot. The whole tree
 * is wrapped in a {@link SearchProvider} carrying the validated `search` (threaded through `RenderProps`
 * identically on SSR + client), so `useSearch` reads the same value on both sides - no hydration
 * mismatch. Shared by the server adapter (renderToWebStream) and the client (hydrate / mountRouter) -
 * the Vue analogue of the React adapter's `compose`.
 */
export function compose(chain: readonly unknown[], props: RenderProps): VNode {
  const last = chain.length - 1
  // `matchChain` feeds `useMatches` through the provider below; on the page it would fall through as
  // an attribute on the page's root element.
  const { matchChain: _chain, ...pageProps } = props as RenderProps & Record<string, unknown>
  const declared = declaredProps(chain[last])
  for (const name of ROUTER_PROPS) if (!declared.has(name)) delete pageProps[name]
  let node: VNode = h(chain[last] as Component, pageProps)
  for (let i = last - 1; i >= 0; i--) {
    const child = node
    // Layouts render their child via the default slot (`<slot />` / `{@render children}`).
    // Each layout receives its own loader data at its own index. Layouts are the chain's leading
    // prefix, so `layoutData[i]` belongs to `chain[i]`; anything past that end (a client-only `_error`
    // boundary marker, the page) reads `undefined` and is unaffected.
    node = h(
      chain[i] as Component,
      {
        data: props.layoutData?.[i] ?? null,
        ...(props.boundaries !== undefined ? { boundaries: props.boundaries } : {}),
      },
      { default: () => child },
    )
  }
  const inner = node
  node = h(RenderPropsProvider, { value: props }, { default: () => inner })
  return h(SearchProvider, { value: props.search ?? EMPTY_SEARCH }, { default: () => node })
}
