---
"@nifrajs/core": minor
"@nifrajs/web": patch
"@nifrajs/cli": patch
---

New: a static `singleCopy` declaration that collapses an identity-sensitive package to one physical copy, for the duplicate no install can remove.

An app that consumes a package by `link:` from a **separate checkout** cannot deduplicate React (or `@nifrajs/*`) by installing differently. The linked files live in the other repo, so their imports resolve from that repo's real path, and that repo's install owns its `node_modules`: peer dependencies are already satisfied there, `overrides` govern the consuming install only, and a deleted nested copy returns on the sibling's next install. The build's existing per-framework dedupe covers bundled output, but nothing covered `bun test`, `bun run`, or a preloaded script - and `nifra check` failed the app with remediation ("deduplicate the install") that the topology makes impossible.

An app now declares the packages in its own `package.json`:

```json
{ "nifra": { "singleCopy": ["react", "react-dom", "@nifrajs/*"] } }
```

Entries are exact names or `@scope/*` patterns; `true` expands to the built-in identity-sensitive set (`@nifrajs/*`, `react`, `react-dom`, `preact`, `solid-js`, `svelte`, `vue`). `@nifrajs/*` is in that set because two copies of `@nifrajs/core` are two distinct `Server` classes, so `.merge()` stops accepting an app built against the other one. The declaration is static so `nifra check` can read it without importing the app's config, which would mean executing app code inside a preflight.

`buildClient` and `buildServer` inject the resolver from the declaration, so bundled output needs no wiring. Unbundled phases are not covered automatically - Bun's runtime resolver never offers a bare specifier to a plugin - so an app preloads `@nifrajs/core/single-copy/register` from `bunfig.toml` (`preload` for `bun run`, `[test].preload` for `bun test`). `nifra check` now names the phase that is left uncovered when the declaration exists without the preload.

The redirect refuses to cross versions: two copies at different versions are skipped as `version-skew` and stay fatal, because collapsing them would turn a loud install problem into a quiet behavioural one. A declared duplicate is reported, not suppressed - `nifra check` keeps printing the copies as a warning and `nifra doctor` lists them under `deduplicatedInstalls` - so the topology stays visible without failing the gate.

New exports: `@nifrajs/core/single-copy` (`singleCopyPlugin`, `registerSingleCopy`, `planSingleCopy`, `readSingleCopyDeclaration`, `readSingleCopyRegistration`, `matchesSingleCopyDeclaration`, `IDENTITY_SENSITIVE_PACKAGES`) and the side-effect entry `@nifrajs/core/single-copy/register`.

The registration proof reads `preload` as entries rather than as text: an entry counts only when it **is** the register specifier, not when it merely contains it. A neighbouring path such as `"./vendor/@nifrajs/core/single-copy/register-shim.ts"` used to satisfy the check while Bun loaded that other module and the registrar never ran, so enforcement was reported as armed on a process still loading both copies. A `preload` this cannot read as quoted entries - a multi-line array, an interpolated value - now reports "not registered" instead of standing in for proof.
