// Preloaded so the dynamically-imported route .svelte files (+ the adapter's Chain/Router/Await) get
// Svelte's SSR-generate transform. Registered before any .svelte import loads.
//   bun --preload examples/routing-svelte/ssr-preload.ts examples/routing-svelte/server.ts
import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"
import { plugin } from "bun"

plugin(svelteBunPlugin("ssr"))
