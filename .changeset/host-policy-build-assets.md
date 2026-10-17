---
"@nifrajs/web": minor
"@nifrajs/node": minor
"@nifrajs/cli": minor
---

An app that serves only some of its pages on some hosts can say so with `createHostPolicy()` from `@nifrajs/web`, and the build's own files stay reachable on those hosts. A rule names the hosts (a list or a predicate), the page routes they get, any other paths (`paths`), and whether they get the build's files (`buildAssets`, on by default). A host no rule names is not restricted. A refused request answers `404` with `cache-control: no-store`, or what `refuse` returns.

- `createWebApp({ hostPolicy, buildAssets })` runs the policy before `use()` middleware, mounts and pages, on Bun and on Node's direct lane.
- `hostPolicy` in `nifra.config.ts` is applied by `nifra build` to every target's generated server entry, static files included: the Bun, Deno and Cloudflare entries check it before serving a file, and `@nifrajs/node`'s `static` reader takes a new `allow(host, pathname)` option the Node entry sets. Cloudflare's `_routes.json` then sends public files through the worker.
- The server manifest exports `buildAssets` (every file the client build emitted and every public file) and `isBuildAsset(pathname)`. `buildServer` takes the manifest `buildClient` returned as `client`, which sets the entry, styles and this set from it; `clientEntry` stays and wins when both are given.
- `checkHostReach()` from `@nifrajs/web/build` renders pages on a host and fetches every same-origin file they reference (scripts and their imports, stylesheets and their `url()`s, preloads, icons, images), expecting `200`, then expects each `refused` path to answer `404`. `nifra smoke` runs it for each entry of a fixture's new `hosts` list.

Apps without a host policy are unchanged.
