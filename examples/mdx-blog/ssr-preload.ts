import { solidMdxBunPlugin } from "@nifrajs/web-solid/mdx"
import { solidBunPlugin } from "@nifrajs/web-solid/plugin"
// Preloaded so the dynamically-imported routes get Solid's SSR transform - `.tsx` via solidBunPlugin,
// `.mdx` via solidMdxBunPlugin (MDX → JSX → @solidjs/compiler + the intrinsics runtime).
import { plugin } from "bun"

plugin(solidBunPlugin("ssr"))
plugin(solidMdxBunPlugin("ssr"))
