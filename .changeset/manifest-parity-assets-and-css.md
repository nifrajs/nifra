---
"@nifrajs/web": patch
---

`nifra build` no longer fails when a route imports a non-JS asset. The development/production manifest parity check compared a source-derived expectation against the build output; its module-graph section held every emitted asset, so any emitted non-JS file (an `import logo from "./logo.svg"`, a font) was a set difference no application could close. The module-graph contract is now the JavaScript module graph only - emitted assets are an output detail, served from source in development and hashed in production, with no dev/prod claim to compare.

The stylesheet check is now directional instead of an equality. The development-side scanner is sound but incomplete by construction - it cannot see a dynamic `import()`, a `require()`, or a bare package `exports` subpath - so a production stylesheet the scanner missed passes, while the load-bearing direction (development found styles the build does not ship, so the page renders unstyled) still fails. The scanner also now recognizes `import(...)` and `require(...)` of a literal stylesheet path.

`manifest.css` now means the same thing on both bundlers: the union of every emitted stylesheet, bootstrap aggregate first. The Bun pipeline previously kept only the aggregate, so a route-scoped stylesheet landed in `assets` but not `css` and normalized to a spurious asset difference.

Parity failures now name the offending files - the production stylesheet URLs and the scanned source root for a css mismatch, the symmetric difference for a module-graph mismatch - and the identity-parity remediation is cause-specific: a version skew says reinstall, a duplicate path across a linked sibling repo says a reinstall will not collapse it and one tree must resolve into the other.
