/**
 * `nifra` — the unscoped meta-entry. Re-exports everything from {@link @nifrajs/core} so a consumer can
 * `import { server } from "nifra"` without learning the scoped layout first. The rest of the framework
 * lives under `@nifrajs/*` (web, client, middleware, schema's `t`, …); scaffold an app with
 * `bun create nifra`. `export *` keeps this in lockstep with core — it can never drift.
 */

export * from "@nifrajs/core"
