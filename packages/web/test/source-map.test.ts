import { expect, test } from "bun:test"
import {
  concatSourceMaps,
  decodeMappings,
  encodeMappings,
  inlineSourceMap,
  originalPosition,
  type RawSourceMap,
  ssrSourceMaps,
} from "../src/internal/source-map.ts"
import { withDevSourceMap } from "../src/plugins/kit.ts"

// Generated line 0 -> a.vue line 2 col 4; generated line 1 col 3 -> a.vue line 5 col 0.
const map = (source = "a.vue"): RawSourceMap => ({
  version: 3,
  sources: [source],
  sourcesContent: ["original"],
  mappings: encodeMappings([Int32Array.of(0, 0, 2, 4), Int32Array.of(3, 0, 5, 0)]),
})

test("encodeMappings is the inverse of decodeMappings, negative deltas included", () => {
  const lines = [Int32Array.of(0, 0, 9, 4, 7, 1, 2, 0), Int32Array.of(), Int32Array.of(1, 0, 0, 0)]
  expect(decodeMappings(encodeMappings(lines))).toEqual(lines)
})

test("originalPosition answers 1-based positions through the map", () => {
  expect(originalPosition(map(), 1, 1)).toEqual({ line: 3, column: 5 })
  expect(originalPosition(map(), 2, 10)).toEqual({ line: 6, column: 1 })
  expect(originalPosition(map(), 9, 1)).toBeUndefined()
})

test("concatSourceMaps shifts each part by the lines and columns before it, and merges sources", () => {
  const joined = concatSourceMaps([
    { code: "one\ntwo\n", map: map() },
    { code: "glue " },
    { code: "x\ny", map: map() },
    { code: "\n", map: map("b.ts") },
  ])
  expect(joined.sources).toEqual(["a.vue", "b.ts"])
  const lines = decodeMappings(joined.mappings)
  // The first part as it was.
  expect(Array.from(lines[0] ?? [])).toEqual([0, 0, 2, 4])
  // The third part starts on line 2 after "glue ", so its first line moves right by 5 columns.
  expect(Array.from(lines[2] ?? [])).toEqual([5, 0, 2, 4])
  expect(Array.from(lines[3] ?? [])).toEqual([3, 0, 5, 0, 1, 1, 2, 4])
})

test("inlineSourceMap reads a trailing base64 map, and nothing else", () => {
  const raw = map()
  const encoded = Buffer.from(JSON.stringify(raw)).toString("base64")
  expect(
    inlineSourceMap(`code()\n//# sourceMappingURL=data:application/json;base64,${encoded}\n`)
      ?.mappings,
  ).toBe(raw.mappings)
  expect(inlineSourceMap("code()\n")).toBeUndefined()
  expect(
    inlineSourceMap("//# sourceMappingURL=data:application/json;base64,bm9wZQ=="),
  ).toBeUndefined()
})

test("withDevSourceMap: inline for the client, registered for SSR, nothing outside a dev server", () => {
  const raw = map()
  delete process.env.NIFRA_DEV_HMR
  expect(withDevSourceMap("x()", raw, "/app/routes/a.vue", "dom")).toBe("x()")
  process.env.NIFRA_DEV_HMR = "1"
  try {
    expect(
      inlineSourceMap(withDevSourceMap("x()", raw, "/app/routes/a.vue", "dom"))?.mappings,
    ).toBe(raw.mappings)
    expect(withDevSourceMap("x()", raw, "/app/routes/b.vue", "ssr")).toBe("x()")
    expect(ssrSourceMaps().get("/app/routes/b.vue")).toBe(raw)
  } finally {
    delete process.env.NIFRA_DEV_HMR
    ssrSourceMaps().delete("/app/routes/b.vue")
  }
})
