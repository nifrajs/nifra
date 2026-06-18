// The frontend adapter for this app. `create-nifra --framework <react|preact|vue|solid|svelte>` swaps
// this one line (and the routes + build config); every server entry imports the adapter from here, so
// they stay framework-agnostic.
import { vueAdapter } from "@nifrajs/web-vue"

export const adapter = vueAdapter
