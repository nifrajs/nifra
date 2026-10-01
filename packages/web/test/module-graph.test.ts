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
    // The record of ids becomes a list - the only shape change, and what a Rollup adapter will emit.
    modules: ["routes/index.tsx", "src/db.ts"],
  })
})

test("a missing or partial metafile is an error: the graph is the evidence", () => {
  expect(() => fromBunMetafile(undefined)).toThrow("produced no module graph")
  expect(() => fromBunMetafile({})).toThrow("produced no module graph")
  expect(() => fromBunMetafile({ outputs: { "a.js": {} } })).toThrow("produced no module graph")
})

test("a module with no imports recorded becomes an empty list, not undefined", () => {
  // The guards iterate imports directly; an undefined here would throw inside the walk.
  const graph = fromBunMetafile({ inputs: { "a.ts": {} }, outputs: {} })
  expect(graph.modules["a.ts"]?.imports).toEqual([])
})

test("entryPoint is omitted rather than set to undefined", () => {
  // exactOptionalPropertyTypes: a present-but-undefined key is not the same as an absent one.
  const graph = fromBunMetafile({ inputs: {}, outputs: { "chunk.js": { inputs: { "a.ts": {} } } } })
  expect("entryPoint" in (graph.chunks["chunk.js"] as object)).toBe(false)
})
