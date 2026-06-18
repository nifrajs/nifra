// `.vue` SFCs are compiled by `vueBunPlugin` (or the consumer's Vue bundler), not by tsc. This ambient
// declaration lets `.ts` code import them with a usable type: the default export is a Vue `Component`.
// Named exports (a route's `loader`/`action`/`meta`) aren't typed here — read them with a cast.
declare module "*.vue" {
  import type { Component } from "vue"

  const component: Component
  export default component
}
