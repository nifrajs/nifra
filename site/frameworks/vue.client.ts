/**
 * Vue hydration entry for the /frameworks live demo — same shape as the React entry, against the Vue
 * catalog component (`bench/ssr/nifra-vue`). Chain `[App]` matches the Vue SSR fragment.
 */

import { hydrate } from "@nifrajs/web-vue/client"
import { App } from "../../bench/ssr/nifra-vue/app.ts"
import { FRAMEWORK_DATA_GLOBAL, frameworkStageId } from "./data.ts"

const data = (globalThis as Record<string, unknown>)[FRAMEWORK_DATA_GLOBAL]
const stage = document.getElementById(frameworkStageId("vue"))
if (stage && data) hydrate([App], { data }, stage)
