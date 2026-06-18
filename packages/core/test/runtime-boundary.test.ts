import { expect, test } from "bun:test"
import { Glob } from "bun"

// Invariant: the request lifecycle is runtime-agnostic. Bun APIs may appear ONLY in
// server.ts's listen()/stop() seam — never in routing, validation, or the app.fetch
// path — so the same app keeps running on Node, Deno, and Workers. Any new `Bun.x()`
// call anywhere in core trips this test, forcing a deliberate decision (and a doc/guard
// update) rather than silently re-coupling core to Bun.
test("Bun APIs stay confined to the server.ts runtime seam (serve + sleep only)", async () => {
  const srcRoot = `${import.meta.dir}/../src`
  const calls: { file: string; method: string }[] = []
  for await (const rel of new Glob("**/*.ts").scan(srcRoot)) {
    const text = await Bun.file(`${srcRoot}/${rel}`).text()
    // Match call expressions (`Bun.serve(`), not comments/type refs (`typeof Bun.serve`).
    for (const match of text.matchAll(/\bBun\.(\w+)\s*\(/g)) {
      calls.push({ file: rel.replaceAll("\\", "/"), method: match[1]! })
    }
  }

  // Every Bun API call lives in the one seam file …
  expect(calls.filter((c) => c.file !== "server/server.ts")).toEqual([])
  // … and is one of exactly two known calls.
  expect([...new Set(calls.map((c) => c.method))].sort()).toEqual(["serve", "sleep"])
})
