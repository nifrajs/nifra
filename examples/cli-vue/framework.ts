// The render adapter — in a multi-target app this file is imported by the edge/server entries, so it
// stays minimal + edge-bundlable: NO Vite plugin or SFC-compiler imports here (those would break the
// `target:"browser"` worker build). The nifra CLI's build/dev tooling lives in `nifra.config.ts`.
import { vueAdapter } from "@nifrajs/web-vue"

export const adapter = vueAdapter
