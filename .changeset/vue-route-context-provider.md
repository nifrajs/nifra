---
"@nifrajs/web-vue": patch
---

Vue pages render faster: the route tree a page renders in now provides `useSearch`'s value and the props `useMatches` and `useLocale` read from one component instead of two nested ones, so each request builds one fewer Vue component instance. On the SSR benchmark's 50-item catalog page this raises throughput by about 12% on Node and 4% on Bun. Server HTML loses one empty `<!--[-->` `<!--]-->` fragment pair, and the client builds the same tree, so hydration still matches. `SearchProvider` and `RenderPropsProvider` are still exported from `@nifrajs/web-vue/router` and work as before.
