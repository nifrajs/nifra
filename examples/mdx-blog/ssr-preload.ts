import { solidBunPlugin } from "@nifrajs/web-solid"
import { solidMdxBunPlugin } from "@nifrajs/web-solid/mdx"
// Preloaded so the dynamically-imported routes get Solid's SSR transform — `.tsx` via solidBunPlugin,
// `.mdx` via solidMdxBunPlugin (MDX → JSX → babel-preset-solid + the intrinsics runtime).
import { plugin } from "bun"

plugin(solidBunPlugin("ssr"))
plugin(solidMdxBunPlugin("ssr"))
