/**
 * Svelte hydration entry for the /frameworks live demo — same shape as the React entry, against the
 * Svelte catalog component (`bench/ssr/nifra-svelte`). Chain `[App]` matches the Svelte SSR fragment.
 * Built with the `.svelte` compiler plugin in `"dom"` (hydratable) mode so the client mounts onto the
 * server-rendered markup instead of replacing it.
 */

import { hydrate } from "@nifrajs/web-svelte/client"
import App from "../../bench/ssr/nifra-svelte/App.svelte"
import { FRAMEWORK_DATA_GLOBAL, frameworkStageId } from "./data.ts"

const data = (globalThis as Record<string, unknown>)[FRAMEWORK_DATA_GLOBAL]
const stage = document.getElementById(frameworkStageId("svelte"))
if (stage && data) hydrate([App], { data }, stage)
