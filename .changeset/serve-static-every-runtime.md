---
"@nifrajs/core": minor
"@nifrajs/node": minor
"@nifrajs/deno": minor
"@nifrajs/web": minor
---

`serveStatic(mounts)` serves files on disk with one set of options on every runtime: from `@nifrajs/core/serve-static` for Bun's `app.listen({ static })`, and from `@nifrajs/node` and `@nifrajs/deno` for their `serve({ static })`. Each reads files with its runtime's own file API, and a mount answers a request the same way on all three.

```ts
import { ONE_DAY, serveStatic } from "@nifrajs/core/serve-static"

app.listen(3000, {
  static: serveStatic([
    { dir: new URL("./dist/assets/", import.meta.url), hashedFiles: build.assets, cacheControl: ONE_DAY },
    { dir: new URL("./public/", import.meta.url), prefix: "/", immutable: false, cacheControl: ONE_DAY, fallthrough: true },
  ]),
})
```

A mount takes `dir`, `prefix` (default `/assets`), `immutable`, `hashedFiles`, `cacheControl`, `files`, `allow`, `headers`, `dotfiles` and `fallthrough`. `hashedFiles` takes paths, an array of RegExps or a `(pathname) => boolean` predicate, matched on the encoded URL path, so files a pre-build step content-hashed, such as the fonts `loadGoogleFont` writes into `public/fonts/`, are cached immutably without being in the build manifest. A global or sticky pattern is used without that flag; a predicate runs as written. A path under a mount's prefix that it cannot serve answers `404` (`400` malformed, `403` traversing) unless the mount sets `fallthrough: true`, which hands it to the next mount and then the app. A request no mount takes returns `undefined` synchronously.

`@nifrajs/web`'s `servePublicDir`, `ServePublicDirOptions`, `PublicDirCache` and `HashedFiles` are removed. `servePublicDir({ dir })` answers as `serveStatic({ dir, prefix: "/", fallthrough: true, hashedFiles: (path) => path.startsWith("/assets/"), cacheControl: ONE_DAY })` does, and `nifra upgrade 5.9.0` makes that edit. `nifra dev` serves `public/` with it, and the servers `nifra build` emits for bun, node and deno pass their runtime's `serveStatic` the same mounts.
