import { describe, expect, test } from "bun:test"
import {
  type Example,
  loadExamplesCorpus,
  renderExamplesResult,
  searchExamples,
} from "../src/examples.ts"

const EXAMPLES: Example[] = [
  {
    name: "PROTECTED_ROUTE",
    topic: "Nifra — Auth & sessions",
    slug: "auth",
    code: 'import { requireSession } from "@nifrajs/better-auth"\n// guard a route',
  },
  {
    name: "UPLOAD",
    topic: "Nifra — Uploads",
    slug: "uploads",
    code: 'import { presign } from "@nifrajs/uploads"\n// signed upload url',
  },
  {
    name: "ISR_PAGE",
    topic: "Nifra — ISR & caching",
    slug: "isr",
    code: 'import { withISR } from "@nifrajs/web"\n// revalidate on a schedule',
  },
]

describe("searchExamples", () => {
  test("slug/topic hits outrank code-body mentions", () => {
    const top = searchExamples(EXAMPLES, "auth session", 2)
    expect(top[0]?.name).toBe("PROTECTED_ROUTE")
  })

  test("matches a code-body term when no label matches", () => {
    expect(searchExamples(EXAMPLES, "presign", 3)[0]?.name).toBe("UPLOAD")
  })

  test("matches common agent aliases and stems", () => {
    expect(searchExamples(EXAMPLES, "authentication", 1)[0]?.name).toBe("PROTECTED_ROUTE")
    expect(searchExamples(EXAMPLES, "uploading", 1)[0]?.name).toBe("UPLOAD")
  })

  test("no terms or no hits → empty", () => {
    expect(searchExamples(EXAMPLES, "", 3)).toEqual([])
    expect(searchExamples(EXAMPLES, "graphql", 3)).toEqual([])
  })
})

describe("renderExamplesResult", () => {
  test("no query → grouped index, not code", () => {
    const out = renderExamplesResult(EXAMPLES, undefined, 3)
    expect(out).toContain("Nifra — Auth & sessions")
    expect(out).toContain("PROTECTED_ROUTE")
    expect(out).not.toContain("```") // index lists names, not code blocks
    expect(out).toContain("typechecked against the installed") // states the guarantee
  })

  test("query → matching example as a fenced code block", () => {
    const out = renderExamplesResult(EXAMPLES, "upload presign", 1)
    expect(out).toContain("## UPLOAD")
    expect(out).toContain("```ts")
    expect(out).toContain("@nifrajs/uploads")
    expect(out).not.toContain("withISR")
  })

  test("no match → actionable message", () => {
    expect(renderExamplesResult(EXAMPLES, "zzz-nothing", 3)).toContain("No examples matched")
  })
})

describe("bundled corpus", () => {
  test("loads the generated examples.json and every snippet imports @nifrajs (the verified contract)", async () => {
    const corpus = await loadExamplesCorpus()
    expect(corpus).toBeDefined()
    const list = corpus as Example[]
    expect(list.length).toBeGreaterThan(20)
    for (const ex of list) {
      expect(ex.code).toMatch(/from\s+['"]@nifrajs\//) // matches check-doc-samples' "checkable" rule
      expect(ex.code).not.toMatch(/<\/[A-Za-z]|\/>/) // no JSX (not typecheckable headless)
    }
    // a real query returns a code block, not the whole corpus
    const out = renderExamplesResult(list, "typed client", 2)
    expect(out).toContain("```ts")
  })
})
