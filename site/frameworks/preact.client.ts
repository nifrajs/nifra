/**
 * Preact hydration entry for the /frameworks live demo — same shape as the React entry, against the
 * Preact catalog component (`bench/ssr/nifra-preact`). The chain is `[App]` (no Layout), matching the
 * Preact SSR fragment the page embedded so hydration reconciles cleanly.
 */

import { hydrate } from "@nifrajs/web-preact/client"
import { App } from "../../bench/ssr/nifra-preact/app.ts"
import { FRAMEWORK_DATA_GLOBAL, frameworkStageId } from "./data.ts"

const data = (globalThis as Record<string, unknown>)[FRAMEWORK_DATA_GLOBAL]
const stage = document.getElementById(frameworkStageId("preact"))
if (stage && data) hydrate([App], { data }, stage)
