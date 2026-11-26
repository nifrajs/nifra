/** What `setup-published.ts` stages, and how it points each file at the installed packages. */

/** Rewrites applied to each copied server file: workspace-relative `dist/` paths become paths into
 * the installed packages. Same `<root>/<pkg>/dist/...` shape on both sides, so only the root moves. */
export const REWRITES: ReadonlyArray<readonly [string, string]> = [
  ["../../packages/core/dist/", "./node_modules/@nifrajs/core/dist/"],
  ["../../packages/middleware/dist/", "./node_modules/@nifrajs/middleware/dist/"],
  ["../../packages/core/src/index.ts", "./node_modules/@nifrajs/core/dist/index.js"],
  // The adapter is imported from `src/` in the workspace (Deno strips types there); an installed
  // consumer resolves the `default` condition to `dist/index.js`, which is what must be measured.
  ["../../packages/deno/src/index.ts", "./node_modules/@nifrajs/deno/dist/index.js"],
  // The Node adapter must become an explicit path too, for two reasons, both verified by marker
  // builds. A BARE `@nifrajs/node` here resolves through the ROOT workspace map - which wins over
  // this directory's node_modules and silently bundles the checkout, the exact failure this script
  // exists to prevent. And Bun's resolver would then take the package's "bun" condition to
  // `src/*.ts`, while a real Node user gets the "default" condition and runs `dist/index.js`. The
  // explicit dist path pins both: published tree, and the artifact Node actually loads.
  ['from "@nifrajs/node"', 'from "./node_modules/@nifrajs/node/dist/index.js"'],
]

/** Server files plus the shared apps. `serve-node.ts` carries the Fastify arm and imports no nifra. */
export const FILES = [
  "_nifra-app.ts",
  "_nifra-node-app.ts",
  "serve.ts",
  "serve-node.ts",
  "serve-node-nifra.ts",
  "serve-deno.ts",
] as const

export function rewriteForPublished(source: string): string {
  let rewritten = source
  for (const [from, to] of REWRITES) rewritten = rewritten.replaceAll(from, to)
  return rewritten
}
