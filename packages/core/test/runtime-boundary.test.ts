import { expect, test } from "bun:test"
import { Glob } from "bun"

/**
 * Modules that are Bun-specific BY DESIGN and never reachable from a request.
 *
 * `single-copy.ts` is a resolver plugin: an app preloads it (`@nifrajs/core/single-copy/register`) or
 * the build injects it, and both are Bun-only phases that happen before any app code runs. It is
 * exempt from the seam rule for that reason, and the second assertion below holds the exemption to it -
 * the moment anything on the request path imports this file, the guard fails again.
 */
const BUILD_TIME_ONLY = new Set(["single-copy.ts", "single-copy-register.ts"])

// Invariant: the request lifecycle is runtime-agnostic. Bun APIs may appear ONLY in
// server.ts's listen()/stop() seam - never in routing, validation, or the app.fetch
// path - so the same app keeps running on Node, Deno, and Workers. Any new `Bun.x()`
// call anywhere in core trips this test, forcing a deliberate decision (and a doc/guard
// update) rather than silently re-coupling core to Bun.
test("Bun APIs stay confined to the server.ts runtime seam (serve + sleep only)", async () => {
  const srcRoot = `${import.meta.dir}/../src`
  const calls: { file: string; method: string }[] = []
  const importsOfBuildTimeOnly: string[] = []
  for await (const rel of new Glob("**/*.ts").scan(srcRoot)) {
    const file = rel.replaceAll("\\", "/")
    const text = await Bun.file(`${srcRoot}/${rel}`).text()
    if (BUILD_TIME_ONLY.has(file)) continue
    // Match call expressions (`Bun.serve(`), not comments/type refs (`typeof Bun.serve`).
    for (const match of text.matchAll(/\bBun\.(\w+)\s*\(/g)) {
      calls.push({ file, method: match[1]! })
    }
    for (const match of text.matchAll(/from\s+"\.{1,2}\/([^"]+)"/g)) {
      const target = match[1]!.replace(/\.ts$/, "")
      if ([...BUILD_TIME_ONLY].some((only) => only.replace(/\.ts$/, "") === target)) {
        importsOfBuildTimeOnly.push(file)
      }
    }
  }

  // Every Bun API call lives in the one seam file …
  expect(calls.filter((c) => c.file !== "server/server.ts")).toEqual([])
  // … and is one of exactly two known calls.
  expect([...new Set(calls.map((c) => c.method))].sort()).toEqual(["serve", "sleep"])
  // … and the exempt build-time modules stay off the request path: nothing else in core imports them,
  // so their Bun dependency cannot leak into an app running on Node, Deno, or Workers.
  expect(importsOfBuildTimeOnly).toEqual([])
})
