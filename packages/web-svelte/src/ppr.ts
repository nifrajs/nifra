import type { Component } from "svelte"

/**
 * What a Svelte boundary's `render` and `fallback` return: a component and the props it renders with.
 * Svelte components compile from files, so a hole's output is this pair instead of a node.
 */
export interface SvelteUI {
  readonly component: Component<Record<string, unknown>>
  readonly props: Record<string, unknown>
}

/** `component` rendered with `props`, for a partially prerendered hole. */
export function ui<Props extends Record<string, unknown>>(
  component: Component<Props>,
  ...props: Record<string, never> extends Props ? [props?: Props] : [props: Props]
): SvelteUI {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the signature checked `props` against this component's own props; the pair only ever renders together.
  return { component: component as Component<Record<string, unknown>>, props: props[0] ?? {} }
}

export const isSvelteUI = (value: unknown): value is SvelteUI =>
  typeof value === "object" &&
  value !== null &&
  "component" in value &&
  typeof value.component === "function" &&
  "props" in value &&
  typeof value.props === "object" &&
  value.props !== null
