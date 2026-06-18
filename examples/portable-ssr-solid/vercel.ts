import { app } from "./app"

// Vercel Edge. `app.fetch` is the universal Web handler; the Edge Runtime dispatches via the fetch
// event — this is exactly what the `edge-runtime` emulator runs (so this file is verifiable locally,
// `bunx edge-runtime --listen dist/vercel/vercel.js`) and what Vercel executes. The edge-target flag
// lives in `vercel.json` (`{ "functions": { "vercel.ts": { "runtime": "edge" } } }`) rather than an
// `export const config`, so the bundle stays a pure fetch-event worker the emulator accepts.
declare const addEventListener: (
  type: "fetch",
  handler: (event: {
    request: Request
    respondWith(r: Response | Promise<Response>): void
  }) => void,
) => void

addEventListener("fetch", (event) => event.respondWith(app.fetch(event.request)))
