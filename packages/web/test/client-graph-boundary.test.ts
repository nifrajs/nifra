import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Glob } from "bun"

/**
 * The browser graph must never name `@nifrajs/web` (the root).
 *
 * The root's module graph carries the server - `renderPage`, `createWebApp`, the static-file server -
 * and a bundler hides that by tree-shaking it away. Vite's dev server does not: it serves each module
 * as written, so one reference from a client-reachable module evaluated `public-dir.ts` in the browser
 * and every framework failed to hydrate with `Module "node:fs/promises" has been externalized`, before
 * a line of app code ran.
 *
 * Two source forms are the trap, because both LOOK type-only and neither disappears:
 *
 *   export type { X } from "@nifrajs/web"          // keeps a bare `import "@nifrajs/web"`
 *   import { type X, type Y } from "@nifrajs/web"  // ditto - inline `type` is not `import type`
 *
 * `import type { X } from "@nifrajs/web"` is erased completely and stays allowed - types must keep
 * coming from the root, because generated code augments `RouteSearch` through
 * `declare module "@nifrajs/web"` and an augmentation lands on the module it names.
 */

const ROOT = resolve(import.meta.dir, "../../..")
const ROOT_SPECIFIER = '"@nifrajs/web"'

/** `export type { … } from "@nifrajs/web"` - transpiles to a bare side-effect import. */
const TYPE_REEXPORT = /export\s+type\s*\{[^}]*\}\s*from\s*"@nifrajs\/web"/g
/** Any `import { … } from "@nifrajs/web"` (not `import type`), for the all-inline-type check below. */
const VALUE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*"@nifrajs\/web"/g

/** Source with comments blanked out - the forbidden forms are quoted in comments explaining them. */
function code(file: string): string {
  return readFileSync(resolve(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
}

async function adapterSources(): Promise<string[]> {
  const files: string[] = []
  for await (const file of new Glob("packages/web-*/src/**/*.{ts,tsx}").scan({ cwd: ROOT })) {
    files.push(file)
  }
  expect(files.length).toBeGreaterThan(0)
  return files
}

test("no adapter source re-exports types FROM the root (it leaves a side-effect import)", async () => {
  const offenders: string[] = []
  for (const file of await adapterSources()) {
    for (const match of code(file).matchAll(TYPE_REEXPORT)) {
      offenders.push(`${file}: ${match[0]}`)
    }
  }
  expect(offenders).toEqual([])
})

test("no adapter source imports ONLY inline types from the root (same trap, different spelling)", async () => {
  const offenders: string[] = []
  for (const file of await adapterSources()) {
    for (const match of code(file).matchAll(VALUE_IMPORT)) {
      const specifiers = (match[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
      if (specifiers.length === 0) continue
      // A genuine value import is fine (it is why the statement exists). An import whose specifiers are
      // ALL inline-`type` is the trap: nothing survives except the module side effect.
      if (specifiers.every((s) => s.startsWith("type "))) {
        offenders.push(`${file}: ${match[0].replace(/\s+/g, " ")}`)
      }
    }
  }
  expect(offenders).toEqual([])
})

test("the generated client entry imports the client subpath, never the root", () => {
  const source = readFileSync(resolve(ROOT, "packages/web/src/index.ts"), "utf8")
  const line = source
    .split("\n")
    .find((l) => l.includes("createClientRouter, createMatcher, mergeHeads, resolveMeta"))
  expect(line).toBeDefined()
  expect(line).toContain('"@nifrajs/web/client"')
  expect(line).not.toContain(`from ${ROOT_SPECIFIER}`)
})
