/**
 * `errorBoundary` — the React error-boundary chain element for nifra's `_error.tsx`. Kept in its own
 * module (imports only `react`, never `react-dom/client`) so it's unit-testable off the DOM and the
 * client codegen can import it from `@nifrajs/web-react/client` (which re-exports it).
 */
import { Component, createElement, type FunctionComponent, type ReactNode } from "react"

/**
 * Build an error-boundary chain element bound to `fallback` (a route's `_error` component). nifra's
 * client codegen inserts it before the page in the matched chain; a render error in the subtree renders
 * `fallback` with `{ data: { name, message } }` instead of crashing the app. DOM-transparent (it renders
 * its children directly — no wrapper element), so it adds no markup and never disturbs hydration.
 */
export function errorBoundary(fallback: unknown): unknown {
  type Props = { children?: ReactNode }
  type State = { error: Error | null }
  return class NifraErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
      super(props)
      this.state = { error: null }
    }
    static getDerivedStateFromError(error: Error): State {
      return { error }
    }
    override render(): ReactNode {
      const { error } = this.state
      if (error === null) return this.props.children
      // `fallback` is the route's `_error` default export — opaque to the core, a component here.
      const Fallback = fallback as FunctionComponent<{ data: { name: string; message: string } }>
      return createElement(Fallback, { data: { name: error.name, message: error.message } })
    }
  }
}
