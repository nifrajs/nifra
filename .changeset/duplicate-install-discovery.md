---
"@nifrajs/cli": patch
"@nifrajs/web": patch
---

Find duplicate installs when `nifra check` runs from an app subdirectory.

The duplicate-install check anchored its discovery at the directory it was run from. In a monorepo you
run it from the app - `apps/web` - and that manifest declares no `workspaces`, so the scan collapsed to
the app itself and the sibling package holding the second copy was never probed. It printed
`✓ duplicate identity-sensitive dependency install: none` while the dev server returned 500 on every
page using a shared-kit hook, from exactly the condition the check exists to detect. Running from an
app subdirectory is the normal case, so that was the configuration it was blind in.

Discovery now walks up to the workspace root that actually governs the directory, and probes from
there. An ancestor is adopted only when its `workspaces` patterns genuinely match - a parent that
merely contains a manifest is not this project's root - and the walk stops at a `.git` boundary.
Findings are still reported relative to where you ran the command.

**Expect this to start reporting real findings in monorepos that were previously green.** That is the
point rather than a regression: the duplicate was always there, and the check simply never looked in
the right place.

An SSR error carrying a duplicate-instance signature (`resolveDispatcher()`, `Invalid hook call`, a
null hook read) now names the likely cause. Two copies at the same version still fail, because module
identity is path-based, and the raw error points at a React internal - so the message now says two
copies are installed at different paths, that matching versions do not fix it, and to run
`nifra check` for the paths.
