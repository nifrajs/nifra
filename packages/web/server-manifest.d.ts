/**
 * Ambient fallback types for a generated `server-manifest` module.
 *
 * `nifra build --target <t>` generates `server-manifest.ts` NEXT TO the server entry at build time, so a
 * HAND-WRITTEN entry that imports `./server-manifest` has nothing to typecheck against until the first
 * build - which is what forces a `@ts-nocheck` onto the very file that deploys. Reference this so the
 * import is typed before then. Either from a `.d.ts` in your project:
 *
 * ```ts
 * /// <reference types="@nifrajs/web/server-manifest" />
 * ```
 *
 * or list it in `tsconfig.json` -> `compilerOptions.types: ["@nifrajs/web/server-manifest"]`.
 *
 * Once a build (or `nifra sync-manifest`) has written the real `server-manifest` next to your entry,
 * TypeScript resolves the relative import to that file and its types win; this only fills the gap before
 * then. Not needed with `nifra build --target`, which generates and bundles its own entry - a hand-written
 * entry is the case this exists for.
 */

declare module "*/server-manifest" {
  import type { Manifest } from "@nifrajs/web"
  /** Hashed client-bootstrap URL the entry passes to `createWebApp` (the hydration `<script src>`). */
  export const clientEntry: string
  /** Global stylesheet URLs, emitted as `<link rel="stylesheet">`. */
  export const styles: readonly string[]
  /** Per-route stylesheet URLs, keyed by route-relative source file. */
  export const routeStyles: Readonly<Record<string, readonly string[]>>
  /** The route manifest `createWebApp` renders. */
  export const manifest: Manifest
}
