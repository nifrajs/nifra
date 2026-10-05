import { solidServerComponents } from "@nifrajs/web-solid/server-components"
import { generateHydrationScript } from "solid-js/web"
export const serverAdapter = solidServerComponents
export const hydrationHead = () => generateHydrationScript()
