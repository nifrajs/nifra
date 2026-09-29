---
"@nifrajs/core": minor
"@nifrajs/web": patch
---

fix(web): the identity preflight behind `nifra check`, `nifra doctor` and the build now scans every
package declared in `"nifra": { "singleCopy": [...] }`, not only the built-in identity-sensitive set.
A declared package installed at two versions is a fatal `version-skew` finding with the same
remediation as a framework skew (align the ranges; nifra never redirects across versions), and one
version at two paths is reported as deduplicated.

feat(core): `@nifrajs/core/single-copy/register` no longer skips silently. Each declared package it
cannot collapse - a version skew, or a linked file with no counterpart in the app's copy - prints one
warning per process naming both copies, both versions and the reason. Strict mode turns that into a
startup failure: declare `"singleCopy": { "packages": [...], "strict": true }` or set
`NIFRA_SINGLE_COPY_STRICT=1`. `SingleCopySkip` gains optional `to`, `fromVersion` and `toVersion`;
`SingleCopyOptions` gains `strict` and `onSkip`; new exports `readSingleCopyStrict` and
`SINGLE_COPY_STRICT_ENV`.
