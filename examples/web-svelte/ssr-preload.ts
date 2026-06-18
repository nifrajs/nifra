// Preloaded so .svelte files (the adapter's Chain/Router + this example's components) get Svelte's
// SSR-generate transform when imported by server.ts. Registered BEFORE any .svelte import loads.
//   bun --preload examples/web-svelte/ssr-preload.ts examples/web-svelte/server.ts
import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"
import { plugin } from "bun"

plugin(svelteBunPlugin("ssr"))
