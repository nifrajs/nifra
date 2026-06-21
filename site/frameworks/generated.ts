/**
 * Typed accessor for the /frameworks live-demo artifact — the prerendered fragments + the REAL measured
 * gzip sizes the build produced. The data file (`../data/frameworks-demo.json`) is regenerated on every
 * `site/build.ts` run by `buildFrameworks` (see build-frameworks.ts); this wrapper just re-types it, the
 * same pattern as `../data/benchmarks.ts`. Importing the JSON (not the builder) keeps the route free of
 * any framework runtime — the static page ships none.
 */
import type { FrameworkDemoEntry, FrameworksDemoArtifact } from "../build-frameworks.ts"
import artifact from "../data/frameworks-demo.json"

const demo = artifact as FrameworksDemoArtifact

/** The five framework rows, in display order, each with its fragment + measured bundle sizes. */
export const FRAMEWORK_ENTRIES: readonly FrameworkDemoEntry[] = demo.entries

/** The shared, static catalog payload — embedded once into the page so each row hydrates from it. */
export const FRAMEWORK_DEMO_DATA = demo.data

/** Item count (50) — shown in the pitch and asserted at build time on every fragment. */
export const FRAMEWORK_ITEM_COUNT: number = demo.itemCount

export type { FrameworkDemoEntry }
