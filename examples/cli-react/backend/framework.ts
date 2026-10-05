/**
 * Deploy-safe render adapter imported by generated server entries. Build/dev-only tooling belongs in
 * `nifra.config.ts` so Vite and its native dependencies never enter the production server bundle.
 */

import { reactAdapter } from "@nifrajs/web-react"

export const adapter = reactAdapter
