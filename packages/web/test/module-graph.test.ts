import { expect, test } from "bun:test"
import { fromBunMetafile } from "../src/module-graph.ts"

test("maps a Bun metafile to the neutral graph", () => {
  const graph = fromBunMetafile({
    inputs: {
      "routes/index.tsx": { imports: [{ path: "node:crypto", original: "node:crypto" }] },
      "src/db.ts": { imports: [] },
    },
    outputs: {
      "dist/index.js": {
        entryPoint: "routes/index.tsx",
        inputs: { "routes/index.tsx": {}, "src/db.ts": {} },
      },
    },
  })
  expect(graph.modules["routes/index.tsx"]?.imports).toEqual([
    { path: "node:crypto", original: "node:crypto" },
  ])
  expect(graph.chunks["dist/index.js"]).toEqual({
    entryPoint: "routes/index.tsx",
    // The record of ids becomes a list — the only shape change, and what a Rollup adapter will emit.
    modules: ["routes/index.tsx", "src/db.ts"],
  })
})

test("a missing or partial metafile yields an empty graph rather than throwing", () => {
  // These are security guards. Crashing on an unexpected build shape fails the build for the wrong
  // reason; an empty graph reports nothing, which is what the guards did with no metafile before.
  expect(fromBunMetafile(undefined)).toEqual({ modules: {}, chunks: {} })
  expect(fromBunMetafile({})).toEqual({ modules: {}, chunks: {} })
  expect(fromBunMetafile({ outputs: { "a.js": {} } })).toEqual({
    modules: {},
    chunks: { "a.js": { modules: [] } },
  })
})

test("a module with no imports recorded becomes an empty list, not undefined", () => {
  // The guards iterate imports directly; an undefined here would throw inside the walk.
  const graph = fromBunMetafile({ inputs: { "a.ts": {} } })
  expect(graph.modules["a.ts"]?.imports).toEqual([])
})

test("entryPoint is omitted rather than set to undefined", () => {
  // exactOptionalPropertyTypes: a present-but-undefined key is not the same as an absent one.
  const graph = fromBunMetafile({ outputs: { "chunk.js": { inputs: { "a.ts": {} } } } })
  expect("entryPoint" in (graph.chunks["chunk.js"] as object)).toBe(false)
})
