---
"@nifrajs/web": minor
"@nifrajs/client": minor
---

Loaders can declare what their data depends on with `ctx.live(...keys)`, and `createWebApp` takes a `live` runtime from the new `@nifrajs/web/live` entry. A live load is a `POST` to `/_nifra/live/load` that runs the target page as a `GET` through every app hook, middleware, gate and loader, and returns an AES-256-GCM grant for the keys the loaders declared, the keys' wire tags and an opaque subject tag. A load that presents a valid grant for the same socket, path, frame and viewer can keep layout and page data without running those loaders, and `live.revoke`, `live.revokeAll` and `live.revokeKey` refuse older grants. Apps without `live` import nothing new, and `ctx.live` does nothing in them.
