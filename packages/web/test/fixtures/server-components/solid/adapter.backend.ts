import { solidServerComponents } from "@nifrajs/web-solid/server-components"
import { generateHydrationScript } from "@solidjs/web"
export const serverAdapter = solidServerComponents
export const hydrationHead = () => generateHydrationScript()
