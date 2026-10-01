---
"@nifrajs/core": minor
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

feat(web): a page file under a mount fails at startup, at build and in `nifra check`, instead of
answering with the mount's 404. A mount in front of the page router - the backend at `apiPrefix`, a
`mounts` entry, or an `app.mount()` inside `use` - answers every request under its path, and its 404
is final (`fallbackOn: 404` only tries the next mount), so a page there could never render.
`createWebApp` now throws at startup, naming each file, the URL it serves and the mount; `nifra build`
refuses to build; and `nifra check` reports `NF-C027` for a page under the backend's prefix, reading
`apiPrefix` when framework.ts exports it as a string literal (an `info` finding says so when it does
not).

`framework.ts` can export `apiPrefix`, `apiStrip`, `mounts`, `csp` and `nonce`. `nifra dev`,
`nifra build` (the generated server entry and the static prerender), `nifra mcp`'s render tool and the
hydration gate pass the same set to `createWebApp`, and the render tool and the hydration gate now
apply `use` as well. A field of the wrong type fails at load, naming it, and a value
`nifra.config.ts` exports must be the one framework.ts exports, or the build stops. `nifra routes`
lists the backend under the configured prefix, at the served path when `apiStrip` is set.

New exports: `preRouteMountPaths` from `@nifrajs/core/mount`; `shadowedPages`,
`formatShadowedPages`, `normalizeMountPath` and `ShadowedPage` from `@nifrajs/web/route-manifest`;
`SERVER_ENTRY_OPTIONS` and the `optionImports` option of `generateServerEntry` and `buildTarget` from
`@nifrajs/web/build`.

Upgrading: an app with a page file under its backend prefix (`routes/api/*` with a `backend.ts`)
started before and answered that page with a 404; it now fails to start until the file moves out of
the prefix or the prefix changes.
