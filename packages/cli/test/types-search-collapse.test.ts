import { expect, test } from "bun:test"
import { renderTypesResult, type TypeEntry } from "../src/types-search.ts"

const big: TypeEntry = {
  name: "Server",
  kind: "class",
  package: "@nifrajs/core",
  doc: "/** The route builder. Chainable, immutable, and typed end to end. */",
  signature: `declare class Server<R, Ctx> {\n${"  method(): void\n".repeat(400)}}`,
}
const small: TypeEntry = {
  name: "RouteSchema",
  kind: "interface",
  package: "@nifrajs/core",
  signature: "interface RouteSchema {\n  body?: unknown\n}",
}
const corpus = [big, small]

test("a query collapses an oversized declaration but keeps it identifiable", () => {
  const out = renderTypesResult(corpus, undefined, "server", 5)
  // A search is "which symbol did I mean?" — one match used to return ~32,000 characters.
  expect(out.length).toBeLessThan(1000)
  expect(out).toContain("Server")
  expect(out).toContain("@nifrajs/core")
  // The head survives, so the shape is still recognisable.
  expect(out).toContain("declare class Server<R, Ctx>")
  expect(out).toContain("members")
  // And it says how to get the rest, or the collapse is just lost information.
  expect(out).toContain('nifra_types({ name: "Server" })')
})

test("a query includes a one-line summary so candidates can be told apart", () => {
  const out = renderTypesResult(corpus, undefined, "server", 5)
  expect(out).toContain("The route builder.")
  // First sentence only — not the whole doc block, and no comment syntax.
  expect(out).not.toContain("Chainable, immutable")
  expect(out).not.toContain("/**")
})

test("a small declaration is never collapsed", () => {
  const out = renderTypesResult(corpus, undefined, "routeschema", 5)
  expect(out).toContain("body?: unknown")
  expect(out).not.toContain("members …")
})

test("an exact name lookup is always complete", () => {
  // This is the case where the caller asked for that symbol — collapsing here would be wrong.
  const out = renderTypesResult(corpus, "Server", undefined, 5)
  expect(out.length).toBeGreaterThan(5000)
  expect(out).not.toContain("members …")
})

test("full: true opts a query back into whole declarations", () => {
  const collapsed = renderTypesResult(corpus, undefined, "server", 5, false)
  const whole = renderTypesResult(corpus, undefined, "server", 5, true)
  expect(whole.length).toBeGreaterThan(collapsed.length * 5)
  expect(whole).not.toContain("members …")
})

test("the index and empty results are unchanged", () => {
  expect(renderTypesResult(corpus, undefined, undefined, 5)).toContain("index")
  expect(renderTypesResult(corpus, undefined, "zzzznomatch", 5)).toContain("No types matched")
  expect(renderTypesResult(corpus, "NoSuchType", undefined, 5)).toContain("No exported type named")
})
