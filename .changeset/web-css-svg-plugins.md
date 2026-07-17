---
"@nifrajs/web": minor
---

Two new build plugins for the `Bun.build` production step, both opt-in and dependency-free until used.

- **`postcssBunPlugin` (`@nifrajs/web/plugins/postcss`)** - runs `*.css` / `*.pcss` / `*.postcss` through PostCSS, feeding the result into the existing stylesheet pipeline (and the CSS-modules scoped-class transform for `*.module.*`). This is the Tailwind v4 path: a `postcss.config.js` with `@tailwindcss/postcss` compiles `app.css` importing `tailwindcss` at build time with no framework-specific code. `postcss` (and `postcss-load-config`, when you don't pass `plugins` explicitly) are optional peers, loaded lazily and failing loud with an install hint. Mirrors the SCSS plugin: pass `"dom"` for the client bundle, preload `"ssr"` for the server.

- **`svgComponentBunPlugin` (`@nifrajs/web/plugins/svg`)** - import an SVG as a component, `import Icon from "./icon.svg?component"`, then `<Icon className="w-6 h-6" />` with props spread onto the root `<svg>` (the Vite `svgr` workflow). Emits an automatic-JSX-runtime component, so it works for React and Preact today; Solid/Svelte/Vue are out of this version. Optional `svgo` optimization. A plain `import "./icon.svg"` asset URL is untouched - only the `?component` marker is intercepted.
