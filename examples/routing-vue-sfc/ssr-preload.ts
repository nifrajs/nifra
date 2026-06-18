// Preloaded so the dynamically-imported route .vue files (+ the adapter's Router/Await) get Vue's
// SSR-generate compile. Registered before any .vue import loads.
//   bun --preload examples/routing-vue-sfc/ssr-preload.ts examples/routing-vue-sfc/server.ts
import { vueBunPlugin } from "@nifrajs/web-vue/plugin"
import { plugin } from "bun"

plugin(vueBunPlugin("ssr"))
