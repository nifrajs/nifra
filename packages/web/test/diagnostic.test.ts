import { expect, test } from "bun:test"
import {
  buildCodeframe,
  buildDiagnostic,
  classify,
  DIAGNOSTIC_CATALOG,
  parseFrames,
  type SourceReader,
  topUserFrame,
} from "../src/diagnostic.ts"

// A fixed source used by the codeframe tests, so no disk is touched.
const SRC = "line1\nline2\nline3\nline4\nline5\nline6\nline7\n"
const reader: SourceReader = (file) => (file === "/app/routes/index.tsx" ? SRC : undefined)

test("parseFrames reads the parenthesised, bare, and async shapes", () => {
  const stack = [
    "Error: boom",
    "    at loader (/app/routes/index.tsx:3:9)",
    "    at /app/src/data.ts:12:1",
    "    at async render (/app/render.ts:5:2)",
  ].join("\n")
  const frames = parseFrames(stack)
  expect(frames).toHaveLength(3)
  expect(frames[0]).toEqual({
    raw: "at loader (/app/routes/index.tsx:3:9)",
    file: "/app/routes/index.tsx",
    line: 3,
    column: 9,
  })
  expect(frames[1]?.file).toBe("/app/src/data.ts")
  expect(frames[2]?.file).toBe("/app/render.ts")
  expect(frames[2]?.line).toBe(5)
})

test("parseFrames strips file:// and ?v= suffixes, and keeps unmatched frames raw", () => {
  const stack = ["    at fn (file:///app/routes/x.tsx?v=abc123:7:4)", "    at <anonymous>"].join(
    "\n",
  )
  const frames = parseFrames(stack)
  expect(frames[0]?.file).toBe("/app/routes/x.tsx")
  expect(frames[0]?.line).toBe(7)
  // Unmatched frame retained with no location - nothing silently dropped.
  expect(frames[1]).toEqual({ raw: "at <anonymous>" })
})

test("topUserFrame skips node_modules, node: builtins, and out-of-root files", () => {
  const frames = parseFrames(
    [
      "    at internal (node:internal/process:1:1)",
      "    at lib (/app/node_modules/dep/index.js:2:2)",
      "    at away (/other/thing.ts:3:3)",
      "    at mine (/app/routes/index.tsx:4:4)",
    ].join("\n"),
  )
  expect(topUserFrame(frames, "/app")?.file).toBe("/app/routes/index.tsx")
  // With no root, node_modules/node: are still excluded, so /other wins first.
  expect(topUserFrame(frames, undefined)?.file).toBe("/other/thing.ts")
})

test("topUserFrame enforces a real path boundary instead of a string prefix", () => {
  const frames = parseFrames(
    [
      "    at sibling (/app-evil/secret.ts:1:1)",
      "    at traversal (/app/routes/../secret.ts:2:2)",
      "    at mine (/app/routes/index.tsx:3:3)",
    ].join("\n"),
  )
  expect(topUserFrame(frames, "/app/routes")?.file).toBe("/app/routes/index.tsx")
})

test("topUserFrame returns undefined when every frame is dependency/runtime", () => {
  const frames = parseFrames("    at x (/app/node_modules/a/b.js:1:1)\n    at y (node:fs:2:2)")
  expect(topUserFrame(frames, "/app")).toBeUndefined()
})

test("buildCodeframe windows around the line, marks the caret, and clamps at the edges", () => {
  const frame = buildCodeframe("/app/routes/index.tsx", 4, 2, reader, 2)
  expect(frame?.lines.map((l) => l.number)).toEqual([2, 3, 4, 5, 6])
  expect(frame?.lines.find((l) => l.caret)?.number).toBe(4)
  // Clamp at the top: line 1 with radius 3 starts at 1, never 0/negative.
  expect(buildCodeframe("/app/routes/index.tsx", 1, undefined, reader, 3)?.lines[0]?.number).toBe(1)
})

test("buildCodeframe returns undefined for an unreadable file or an out-of-range line", () => {
  expect(buildCodeframe("/missing.tsx", 3, 1, reader)).toBeUndefined()
  expect(buildCodeframe("/app/routes/index.tsx", 999, 1, reader)).toBeUndefined()
  expect(buildCodeframe("/app/routes/index.tsx", 0, 1, reader)).toBeUndefined()
})

test("buildCodeframe falls back to the filesystem reader for a missing file (no throw)", () => {
  // Exercises the default reader path without asserting content - a nonexistent path yields undefined.
  expect(buildCodeframe("/definitely/not/here.tsx", 1, 1)).toBeUndefined()
})

test("classify recognises the seeded failure shapes and falls back to unhandled", () => {
  expect(classify("Error", "server-only module(s) in the client bundle: ...").code).toBe(
    "NIFRA_SERVER_ONLY_IN_CLIENT",
  )
  expect(classify("Error", "Node built-in(s) in the client bundle").code).toBe(
    "NIFRA_NODE_BUILTIN_IN_CLIENT",
  )
  expect(classify("SchemaError", "whatever").code).toBe("NIFRA_SCHEMA_PARSE")
  const generic = classify("TypeError", "x is not a function")
  expect(generic.code).toBe("NIFRA_UNHANDLED")
  expect(generic.fix).toBeUndefined()
})

test("every catalog entry carries a cause, fix, and docs anchor", () => {
  for (const entry of DIAGNOSTIC_CATALOG) {
    expect(entry.code.startsWith("NIFRA_")).toBe(true)
    expect(entry.cause.length).toBeGreaterThan(0)
    expect(entry.fix.length).toBeGreaterThan(0)
    expect(entry.docsAnchor).toContain("errors#")
  }
})

test("buildDiagnostic resolves a recognised error end to end with a codeframe", () => {
  const err = new Error("server-only module(s) in the client bundle: /app/secrets.ts")
  err.stack = [
    "Error: server-only module(s) in the client bundle: /app/secrets.ts",
    "    at loader (/app/node_modules/@nifrajs/web/dist/build.js:1:1)",
    "    at handler (/app/routes/index.tsx:3:9)",
  ].join("\n")
  const diag = buildDiagnostic(err, {
    request: { method: "GET", url: "/" },
    root: "/app",
    read: reader,
  })
  expect(diag.code).toBe("NIFRA_SERVER_ONLY_IN_CLIENT")
  expect(diag.request).toEqual({ method: "GET", url: "/" })
  expect(diag.codeframe?.file).toBe("/app/routes/index.tsx")
  expect(diag.codeframe?.line).toBe(3)
  expect(diag.fix).toContain("server-only")
  expect(diag.docsAnchor).toBe("errors#server-only-in-client")
})

test("buildDiagnostic tolerates a non-Error throw and a stackless error", () => {
  const fromString = buildDiagnostic("plain string boom", { root: "/app", read: reader })
  expect(fromString.name).toBe("Error")
  expect(fromString.message).toContain("plain string boom")
  expect(fromString.code).toBe("NIFRA_UNHANDLED")

  const noStack = new Error("no frames here")
  noStack.stack = "Error: no frames here" // a message-only stack: no `at` frames to parse
  const diag = buildDiagnostic(noStack, { root: "/app", read: reader })
  expect(diag.message).toBe("no frames here")
  expect(diag.codeframe).toBeUndefined()
  expect(diag.frames).toEqual([])
})
