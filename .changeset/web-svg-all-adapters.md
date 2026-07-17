---
"@nifrajs/web-solid": minor
"@nifrajs/web-svelte": minor
"@nifrajs/web-vue": minor
---

Extend `import Icon from "./icon.svg?component"` to the Solid, Svelte, and Vue adapters (`@nifrajs/web-solid/svg`, `@nifrajs/web-svelte/svg`, `@nifrajs/web-vue/svg`), joining the React/Preact plugin.

Each is a Bun build plugin that turns a `?component` SVG import into a framework component with the caller's props/attrs spread onto the root `<svg>`, using that framework's own compiler: Solid emits `class`-form JSX through `babel-preset-solid`; Svelte wraps the raw SVG in a Svelte 5 component (compiled by `svelte/compiler`); Vue wraps it in a single-root template so Vue's attribute inheritance forwards props to the `<svg>` (compiled by `@vue/compiler-sfc`). A plain `import "./icon.svg"` asset URL is untouched - only `?component` is intercepted. The shared `svgToJsx` transform gained a `classProp` option.
