/**
 * React hydration entry for the /frameworks live demo. Imports the SAME catalog component the SSR
 * bench app renders (`bench/ssr/nifra`), reads the static payload the page embedded, and hydrates the
 * server-rendered fragment in place. Built into its own minified browser bundle by build-frameworks.ts;
 * the toggle island loads it (and only it) when React is the active row, so the shown framework is live.
 */

import { hydrate } from "@nifrajs/web-react/client"
import { App } from "../../bench/ssr/nifra/app.tsx"
import Layout from "../../bench/ssr/nifra/layout.tsx"
import { FRAMEWORK_DATA_GLOBAL, frameworkStageId } from "./data.ts"

const data = (globalThis as Record<string, unknown>)[FRAMEWORK_DATA_GLOBAL]
const stage = document.getElementById(frameworkStageId("react"))
if (stage && data) hydrate([Layout, App], { data }, stage)
