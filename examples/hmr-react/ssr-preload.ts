import { mdxBunPlugin } from "@nifrajs/content/mdx"
import { plugin } from "bun"

// Compiles `.mdx` routes for nifra's Bun-side SSR (the client/HMR side uses @mdx-js/rollup in dev.ts's
// Vite plugins). Preload it: `bun --preload examples/hmr-react/ssr-preload.ts examples/hmr-react/dev.ts`.
plugin(mdxBunPlugin({ jsxImportSource: "react" }))
