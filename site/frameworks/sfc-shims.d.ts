// The /frameworks demo imports the bench catalog's `.svelte` and `.vue` components, which their compiler
// plugins build and `tsc` cannot read. These mirror the adapters' own shims (web-svelte, web-vue).
declare module "*.svelte" {
  import type { Component } from "svelte"

  const component: Component<Record<string, unknown>>
  export default component
}

declare module "*.vue" {
  import type { Component } from "vue"

  const component: Component
  export default component
}
