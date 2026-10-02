---
"@nifrajs/cli": minor
---

feat(cli): `nifra upgrade` runs every release recipe between the installed version and the target

The installed version is the lowest `@nifrajs/*`, `nifra` or `create-nifra` version the workspace
declares. `nifra upgrade <version>` applies each release recipe after it, up to the target, oldest
first - dependency moves, import moves and notes labeled by release - then pins the fixed group to the
target, so a 1.x or 2.x app reaches the target in one run. Any version up to the CLI's own is a target.
`--exact` pins exact versions instead of keeping `^`/`~`.

A target newer than the CLI prints the command for that release's CLI
(`bunx @nifrajs/cli@<version> upgrade <version>`, with the same flags) and changes nothing; a target
that is not a bare release version is refused. The 4.0.0 recipe moves `@nifrajs/web/server-only`
imports to `@nifrajs/web/backend-only`, leads with `nifra migrate layout`, and notes the changes an
existing app may observe: the zoned layout, required output schemas, the credential scan, the
`cloudflare` target name, `withISR` query bypass, pages under a mount failing at startup, exact method matching,
resolved dot segments, JSON media-type matching, required endpoint secrets, the empty `clientEntry`
error, typed-client dot-segment refusal, canonical base64url signatures and locale-formatted plural `#`.
