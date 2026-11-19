import { afterEach, beforeEach, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

// NF-C059 (a route hook that names another route than its page's) and NF-C060 (a cast to Href), pinned
// one behaviour at a time: what a mutation of `rules/route-hooks.ts` or the two facts it reads has to
// change for one of these to fail.

let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-check-route-hooks-scan-")
  writeAppFile(
    root,
    "backend/routes.ts",
    'import { server } from "@nifrajs/core/server"\nexport const app = server().get("/api/health", () => ({ ok: true }))\n',
  )
})
afterEach(() => removeFixtureRoot(root))

interface Finding {
  readonly code: string
  readonly file: string
  readonly line: number
}

async function scan(code: string): Promise<Finding[]> {
  const result = await collectCheckResult(root, { lintsOnly: true })
  return result.diagnostics
    .filter((item) => item.code === code)
    .map((item) => ({ code, file: item.file ?? "", line: item.line ?? 0 }))
}

const ROUTER = "@nifrajs/web-react/router"

function page(
  file: string,
  body: string,
  imports = `import { useParams, useSearch } from "${ROUTER}"`,
): void {
  writeAppFile(
    root,
    `routes/${file}`,
    `${imports}\nexport default function Page() {\n${body}\n  return null\n}\n`,
  )
}

test("a page that names its own route is clean", async () => {
  page("reports.tsx", '  useSearch("/reports")\n  useParams("/reports")')
  expect(await scan("NF-C059")).toEqual([])
})

test("a page that names another route is reported at the call", async () => {
  page("reports.tsx", '  useSearch("/other")')
  expect(await scan("NF-C059")).toEqual([{ code: "NF-C059", file: "routes/reports.tsx", line: 3 }])
})

test("useParams is held to the page's route too", async () => {
  page("users/[id].tsx", '  useParams("/users/:name")')
  expect((await scan("NF-C059")).map((item) => item.line)).toEqual([3])
})

test("a page with an optional segment accepts either of its patterns", async () => {
  page(
    "[[lang]]/docs.tsx",
    '  useSearch("/docs")\n  useSearch("/:lang/docs")\n  useSearch("/nope")',
  )
  expect((await scan("NF-C059")).map((item) => item.line)).toEqual([5])
})

test("a hook imported under another name is still checked", async () => {
  page(
    "reports.tsx",
    '  readSearch("/other")',
    `import { useSearch as readSearch } from "${ROUTER}"`,
  )
  expect((await scan("NF-C059")).map((item) => item.line)).toEqual([3])
})

test("an argument that is not a literal, and a hook from elsewhere, are left alone", async () => {
  page("reports.tsx", "  const from = String(Math.random())\n  useSearch(from as never)")
  page("other.tsx", '  useSearch("/nope")', 'import { useSearch } from "./not-the-router.ts"')
  expect(await scan("NF-C059")).toEqual([])
})

test("a layout and a component outside routes/ are not held to a page's route", async () => {
  writeAppFile(
    root,
    "routes/_layout.tsx",
    `import { useSearch } from "${ROUTER}"\nexport default function Layout() {\n  useSearch("/anything")\n  return null\n}\n`,
  )
  writeAppFile(
    root,
    "components/shared.tsx",
    `import { useSearch } from "${ROUTER}"\nexport function Shared() {\n  useSearch("/anything")\n  return null\n}\n`,
  )
  page("reports.tsx", "")
  expect(await scan("NF-C059")).toEqual([])
})

test("a nifra-expect comment with a reason accepts the call", async () => {
  page(
    "reports.tsx",
    '  // nifra-expect NF-C059: shared with the archive page\n  useSearch("/archive")',
  )
  expect(await scan("NF-C059")).toEqual([])
})

const CAST_IMPORT = 'import { type Href, rawHref } from "@nifrajs/web-react/router"'

test("a cast to Href is reported, in either syntax", async () => {
  writeAppFile(
    root,
    "routes/index.tsx",
    `${CAST_IMPORT}\nexport const a = "/x" as Href\nexport const c = rawHref("/z")\nexport default function Page() {\n  return null\n}\n`,
  )
  writeAppFile(root, "lib/cast.ts", `${CAST_IMPORT}\nexport const b = <Href>"/y"\n`)
  expect((await scan("NF-C060")).map((item) => `${item.file}:${item.line}`).sort()).toEqual([
    "lib/cast.ts:2",
    "routes/index.tsx:2",
  ])
})

test("a type named Href that is not nifra's is not a cast to it", async () => {
  writeAppFile(
    root,
    "routes/index.tsx",
    'type Href = string\nexport const a = "/x" as Href\nexport default function Page() {\n  return null\n}\n',
  )
  expect(await scan("NF-C060")).toEqual([])
})

test("a cast inside a test directory is left alone, and an accepted one too", async () => {
  writeAppFile(
    root,
    "routes/index.tsx",
    `${CAST_IMPORT}\n// nifra-expect NF-C060: a CMS link checked upstream\nexport const a = "/x" as Href\nexport default function Page() {\n  return null\n}\n`,
  )
  writeAppFile(root, "tests/probe.ts", `${CAST_IMPORT}\nexport const a = "/x" as Href\n`)
  expect(await scan("NF-C060")).toEqual([])
})
