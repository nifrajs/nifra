/**
 * Solid hydration entry for the /frameworks live demo — same shape as the React entry, against the
 * Solid catalog component (`bench/ssr/nifra-solid`). Chain `[App]` matches the Solid SSR fragment.
 * Built with the Solid Babel plugin (`generate: "dom"`, `hydratable`) so the client tree aligns with
 * the `data-hk`-keyed SSR markup; the page injects Solid's `generateHydrationScript()` (the adapter's
 * `hydrationHead`) before loading this bundle, which `hydrate` requires.
 */

import { hydrate } from "@nifrajs/web-solid/client"
import { App } from "../../bench/ssr/nifra-solid/app.tsx"
import { FRAMEWORK_DATA_GLOBAL, frameworkStageId } from "./data.ts"

const data = (globalThis as Record<string, unknown>)[FRAMEWORK_DATA_GLOBAL]
const stage = document.getElementById(frameworkStageId("solid"))
if (stage && data) hydrate([App], { data }, stage)
