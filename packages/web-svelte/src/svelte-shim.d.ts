// `.svelte` files are compiled by `svelteBunPlugin` (or the consumer's Svelte bundler), not by tsc.
// This ambient declaration lets the .ts adapter/client import them with a usable type. The default
// export is a Svelte 5 `Component`; our helpers take a loose props bag (the chain + the loader props).
declare module "*.svelte" {
  import type { Component } from "svelte"

  const component: Component<Record<string, unknown>>
  export default component
}
