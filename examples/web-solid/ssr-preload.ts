import { solidBunPlugin } from "@nifrajs/web-solid"
// Preloaded so the server runtime compiles .tsx route components with Solid's SSR transform.
import { plugin } from "bun"

plugin(solidBunPlugin("ssr"))
