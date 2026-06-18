import { solidBunPlugin } from "@nifrajs/web-solid"
// Preloaded so dynamically-imported route .tsx files get Solid's SSR transform.
import { plugin } from "bun"

plugin(solidBunPlugin("ssr"))
