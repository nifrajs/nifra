/**
 * `errorBoundary` — the Preact error-boundary chain element for nifra's `_error.tsx`. Its own module
 * (imports only `preact`) so it's unit-testable off the DOM and the client codegen can import it from
 * `@nifrajs/web-preact/client` (which re-exports it).
 */
import { Component, type ComponentChildren, createElement, type FunctionComponent } from "preact"

/**
 * Build an error-boundary chain element bound to `fallback` (a route's `_error` component). nifra's
 * client codegen inserts it before the page in the matched chain; a render error in the subtree renders
 * `fallback` with `{ data: { name, message } }` instead of crashing the app. DOM-transparent (it renders
 * its children directly — no wrapper element), so it adds no markup and never disturbs hydration.
 */
export function errorBoundary(fallback: unknown): unknown {
  type Props = { children?: ComponentChildren }
  type State = { error: Error | null }
  return class NifraErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
      super(props)
      this.state = { error: null }
    }
    static override getDerivedStateFromError(error: Error): State {
      return { error }
    }
    override render(): ComponentChildren {
      const { error } = this.state
      if (error === null) return this.props.children
      // `fallback` is the route's `_error` default export — opaque to the core, a component here.
      const Fallback = fallback as FunctionComponent<{ data: { name: string; message: string } }>
      return createElement(Fallback, { data: { name: error.name, message: error.message } })
    }
  }
}
