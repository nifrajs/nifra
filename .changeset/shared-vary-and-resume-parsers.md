---
"@nifrajs/core": minor
"@nifrajs/agent": minor
"@nifrajs/a2a": patch
"@nifrajs/ag-ui": patch
"@nifrajs/i18n": patch
"@nifrajs/middleware": patch
---

`@nifrajs/core` exports `varyOn(value, names)` from its root and `/server`: the `Vary` value that names each of `names` once, matched without regard to case, with `Vary: *` returned unchanged. The i18n `localeDetector()` and the middleware `language()` plugin set their `Vary` with it.

`@nifrajs/agent` exports `parseAgentResume(raw)`, which reads a turn's `resume` (`{ continuation, approval? }`) from an untrusted value and returns `undefined` for anything else. The agent mount, A2A and AG-UI transports all parse a resume with it, so a continuation is accepted on the same terms whichever protocol carries it.

`etag()` and `prettyJson()` release the upstream body's reader lock once a replayed body ends, fails, or is cancelled, as `cache()` already did.
