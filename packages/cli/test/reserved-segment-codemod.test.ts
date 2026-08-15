import { describe, expect, test } from "bun:test"
import {
  type CollisionSite,
  parseCollisionSites,
  rewriteFile,
} from "../src/internal/reserved-segment-codemod.ts"

/**
 * The codemod edits a user's source from compiler output, so both halves need proof: that it reads
 * only the diagnostics it understands, and that it declines - visibly - every shape it does not.
 * A codemod that quietly rewrites the wrong span is worse than the manual toil it replaces.
 */

/** Build a site pointing at the first occurrence of `property` in `source`, as `tsc` would report it. */
const siteAt = (source: string, property: string, segment: string): CollisionSite => {
  const offset = source.indexOf(property)
  if (offset === -1) throw new Error(`fixture does not contain ${property}`)
  const before = source.slice(0, offset)
  const lastNewline = before.lastIndexOf("\n")
  return {
    file: "src/app.ts",
    line: before.split("\n").length,
    column: offset - lastNewline,
    segment,
  }
}

describe("parseCollisionSites", () => {
  test("reads file, position, and the colliding segment out of the compiler's message", () => {
    const sites = parseCollisionSites(
      [
        `src/app.ts(9,16): error TS2339: Property 'post' does not exist on type 'ReservedSegmentCollision<"delete">'.`,
        `src/app.ts(10,20): error TS2339: Property 'get' does not exist on type 'ReservedSegmentCollision<"subscribe">'.`,
      ].join("\n"),
    )
    expect(sites).toEqual([
      { file: "src/app.ts", line: 9, column: 16, segment: "delete" },
      { file: "src/app.ts", line: 10, column: 20, segment: "subscribe" },
    ])
  })

  test("an unrelated compiler error is not a rewrite site", () => {
    // The codemod runs over the WHOLE typecheck output, which in a broken project is mostly errors
    // that have nothing to do with this. Acting on one would edit unrelated code.
    expect(
      parseCollisionSites(
        [
          "src/app.ts(3,1): error TS2304: Cannot find name 'foo'.",
          "src/other.ts(7,7): error TS6133: 'node' is declared but its value is never read.",
          "some prose that is not a diagnostic at all",
        ].join("\n"),
      ),
    ).toEqual([])
  })
})

describe("rewriteFile", () => {
  test("rewrites a property access into the call spelling", () => {
    const source = 'const r = await api.api.delete.post({ id: "1" })\n'
    const result = rewriteFile(source, [siteAt(source, "post", "delete")])
    expect(result.source).toBe('const r = await api.api("delete").post({ id: "1" })\n')
    expect(result.skipped).toEqual([])
  })

  test("rewrites a chain broken across lines", () => {
    // The scan runs backwards over the source, not over one line, so formatting does not decide
    // whether a site is fixable.
    const source = "const r = await api.jobs\n  .subscribe\n  .get()\n"
    const result = rewriteFile(source, [siteAt(source, "get()", "subscribe")])
    expect(result.source).toBe('const r = await api.jobs("subscribe")\n  .get()\n')
  })

  test("preserves the segment's casing", () => {
    // Verbs are intercepted case-insensitively, so `/api/Delete` collides too - and the rewritten
    // path segment has to stay `Delete` or the request goes somewhere else.
    const source = "await api.api.Delete.post()\n"
    expect(rewriteFile(source, [siteAt(source, "post", "Delete")]).source).toBe(
      'await api.api("Delete").post()\n',
    )
  })

  test("rewrites several sites in one file without shifting each other", () => {
    const source = ["await api.api.delete.post()", "await api.jobs.subscribe.get()"].join("\n")
    const result = rewriteFile(source, [
      siteAt(source, "post", "delete"),
      siteAt(source, "get()", "subscribe"),
    ])
    expect(result.source).toBe(
      ['await api.api("delete").post()', 'await api.jobs("subscribe").get()'].join("\n"),
    )
    expect(result.skipped).toEqual([])
  })

  test("declines bracket access instead of guessing a span", () => {
    const source = 'await api.api["delete"].post()\n'
    const result = rewriteFile(source, [siteAt(source, "post", "delete")])
    expect(result.source).toBe(source)
    expect(result.skipped).toHaveLength(1)
  })

  test("declines a collision node held in a variable", () => {
    // `node.post()` has no `.delete` before it to rewrite; the edit belongs at the declaration, and
    // which declaration that is is not something this scan can answer.
    const source = "const node = api.api.delete\nawait node.post()\n"
    const result = rewriteFile(source, [siteAt(source, "post()", "delete")])
    expect(result.source).toBe(source)
    expect(result.skipped).toHaveLength(1)
  })

  test("a site whose position is past the end of the file is skipped, not thrown on", () => {
    // The compiler output and the file on disk can disagree if something else edited it mid-run.
    const source = "await api.api.delete.post()\n"
    const result = rewriteFile(source, [
      { file: "src/app.ts", line: 99, column: 4, segment: "delete" },
    ])
    expect(result.source).toBe(source)
    expect(result.skipped).toHaveLength(1)
  })
})
