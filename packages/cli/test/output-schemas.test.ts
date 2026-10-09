import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { buildManifest, createWebApp } from "@nifrajs/web"
import { collectCheckResult } from "../src/check.ts"
import {
  outputSchemas,
  schemaSource,
  staleGeneratedSchemas,
  undeclaredPaths,
} from "../src/output-schemas.ts"

const repo = resolve(import.meta.dir, "../../..")
const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function project(files: Record<string, string>, typescript?: string): string {
  const root = mkdtempSync(join(tmpdir(), "nifra-output-schemas-"))
  roots.push(root)
  const all: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        noEmit: true,
        paths: {
          "@nifrajs/schema": [`${repo}/packages/schema/src/index.ts`],
          "@nifrajs/web": [`${repo}/packages/web/src/index.ts`],
        },
      },
      include: ["routes"],
    }),
    ...files,
  }
  for (const [file, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  if (typescript !== undefined) {
    mkdirSync(join(root, "node_modules"), { recursive: true })
    const pkg = Bun.resolveSync(`${typescript}/package.json`, import.meta.dir)
    symlinkSync(dirname(pkg), join(root, "node_modules", "typescript"))
  }
  return root
}

const read = (root: string, file: string): string => readFileSync(join(root, file), "utf8")

const FEED = [
  'import { defer, redirect } from "@nifrajs/web"',
  "",
  "interface Row { id: string; title: string; createdAt: Date; passwordHash: string }",
  "",
  "/** The feed. */",
  "export async function loader({ request }: { request: Request }) {",
  '  if (request.url.endsWith("/old")) return redirect("/feed")',
  "  const rows: Row[] = []",
  "  return {",
  "    rows,",
  "    count: rows.length,",
  '    mode: rows.length > 0 ? ("full" as const) : ("empty" as const),',
  "    pinned: null as { id: string; at?: Date } | null,",
  '    meta: JSON.parse("{}") as unknown,',
  "    open: rows.length > 0,",
  "    later: defer(Promise.resolve([{ score: 1 }])),",
  "    tags: new Map<string, string>(),",
  '    "x-total": 2,',
  "  }",
  "}",
  "",
].join("\n")

const FEED_SCHEMA = `t.object({
  rows: t.array(t.object({
    id: t.string(),
    title: t.string(),
    createdAt: t.date(),
    // left out: passwordHash - a credential-like name; declare it with t.declassified("why", ...) if it must reach the browser
  })),
  count: t.number(),
  mode: t.union([t.literal("empty"), t.literal("full")]),
  pinned: t.union([t.object({
    id: t.string(),
    at: t.optional(t.date()),
  }), t.null()]),
  meta: t.json() /* unknown in the source type */,
  open: t.boolean(),
  later: t.deferred(t.array(t.object({
    score: t.number(),
  }))),
  // left out: tags - a Map, which is not JSON
  "x-total": t.number(),
})`

describe("generating a missing schema", () => {
  test("a dry run reports it; --write puts it above the loader with its marker and import", async () => {
    const root = project({ "routes/feed.backend.ts": FEED })
    const dry = await outputSchemas(root)
    expect(dry.warnings).toEqual([])
    expect(dry.entries).toEqual([
      {
        file: "routes/feed.backend.ts",
        line: 6,
        schema: "loaderOutput",
        status: "missing",
        generated: false,
        dropped: [],
      },
    ])
    expect(read(root, "routes/feed.backend.ts")).toBe(FEED)

    const wrote = await outputSchemas(root, { write: true })
    expect(wrote.entries.map((e) => e.status)).toEqual(["generated"])
    expect(wrote.written).toEqual(["routes/feed.backend.ts"])
    const text = read(root, "routes/feed.backend.ts")
    expect(
      text.startsWith(
        'import { defer, redirect } from "@nifrajs/web"\nimport { t } from "@nifrajs/schema"\n',
      ),
    ).toBe(true)
    // Above the doc comment, so the comment stays on the loader.
    expect(text).toContain(
      `export const loaderOutput = ${FEED_SCHEMA}\n\n/** The feed. */\nexport async function loader`,
    )
    expect(text).toMatch(/\/\/ nifra:generated [0-9a-f]{8} - from the loader's return type;/)

    const again = await outputSchemas(root)
    expect(again.entries.map((e) => e.status)).toEqual(["current"])
    expect(again.ok).toBe(true)

    // The written module runs as a route's backend half: the output guard accepts what its loader
    // returns and drops what the schema left out.
    const backend = await import(join(root, "routes/feed.backend.ts"))
    let rendered: unknown
    const app = createWebApp({
      adapter: {
        renderToStream: (_chain, props) => {
          rendered = props.data
          return new Blob(["<main></main>"]).stream()
        },
        hydrationHead: () => "",
      },
      clientEntry: "/c.js",
      manifest: buildManifest(
        ["_error.tsx", "feed.tsx", "feed.backend.ts"],
        (file) => async () => (file === "feed.backend.ts" ? backend : { default: file }),
      ),
    })
    const res = await app.fetch(new Request("http://x/feed"))
    await res.text()
    expect(res.status).toBe(200)
    expect(Object.keys(Object(rendered))).toEqual([
      "rows",
      "count",
      "mode",
      "pinned",
      "meta",
      "open",
      "later",
      "x-total",
    ])
  }, 60_000)

  for (const typescript of ["typescript5", "typescript7"]) {
    test(`${typescript} reads the same shape`, async () => {
      const root = project({ "routes/feed.backend.ts": FEED }, typescript)
      const wrote = await outputSchemas(root, { write: true })
      expect(wrote.warnings).toEqual([])
      expect(read(root, "routes/feed.backend.ts")).toContain(
        `export const loaderOutput = ${FEED_SCHEMA}\n`,
      )
    }, 60_000)
  }

  test("a loader that only redirects or returns nothing has no data to describe", async () => {
    const root = project({
      "routes/out.backend.ts": [
        'import { redirect } from "@nifrajs/web"',
        "export async function loader({ request }: { request: Request }) {",
        '  if (request.url.endsWith("/x")) return redirect("/")',
        "  return",
        "}",
        "",
      ].join("\n"),
    })
    expect((await outputSchemas(root)).entries.map((e) => e.status)).toEqual(["no-data"])
  }, 60_000)

  test("a file where t already names something else is left alone", async () => {
    const source = [
      'import { t } from "./i18n.ts"',
      "export const loader = () => ({ title: t })",
      "",
    ].join("\n")
    const root = project({
      "routes/i18n.ts": "export const t = 'hello'\n",
      "routes/page.backend.ts": source,
    })
    const report = await outputSchemas(root, { write: true })
    expect(report.entries).toEqual([
      expect.objectContaining({
        status: "missing",
        reason: "`t` already names something else in this file, so it was left as is",
      }),
    ])
    expect(report.written).toEqual([])
    expect(read(root, "routes/page.backend.ts")).toBe(source)
  }, 60_000)
})

describe("a generated schema over time", () => {
  const initial = [
    'import { t } from "@nifrajs/schema"',
    "export const loader = () => ({ name: 'Ada' })",
    "",
  ].join("\n")

  test("a changed return type makes it stale for nifra schemas and NF-C033, and --write refreshes it", async () => {
    const root = project({ "routes/me.backend.ts": initial })
    await outputSchemas(root, { write: true })
    const generated = read(root, "routes/me.backend.ts")
    expect(generated).toContain("export const loaderOutput = t.object({\n  name: t.string(),\n})")
    writeFileSync(
      join(root, "routes/me.backend.ts"),
      generated.replace("({ name: 'Ada' })", "({ name: 'Ada', avatar: { url: 'x' } })"),
    )

    const dry = await outputSchemas(root)
    expect(dry.ok).toBe(false)
    expect(dry.entries).toEqual([
      expect.objectContaining({ status: "stale", dropped: ["avatar"], line: 3 }),
    ])
    const fs = (file: string) => readFileSync(join(root, file), "utf8")
    const { stale } = await staleGeneratedSchemas(root, ["routes/me.backend.ts"], fs)
    expect(stale.map((e) => e.file)).toEqual(["routes/me.backend.ts"])

    writeFileSync(join(root, "routes/me.tsx"), "export default () => null\n")
    const check = await collectCheckResult(root, { lintsOnly: true })
    const finding = check.diagnostics.find((d) => d.code === "NF-C033")
    expect(finding?.severity).toBe("error")
    expect(finding?.message).toContain("it now returns avatar, which the schema drops")

    const fixed = await outputSchemas(root, { write: true })
    expect(fixed.entries.map((e) => e.status)).toEqual(["regenerated"])
    expect(read(root, "routes/me.backend.ts")).toContain(
      "  avatar: t.object({\n    url: t.string(),\n  }),\n})",
    )
    expect(read(root, "routes/me.backend.ts").match(/nifra:generated/g)).toHaveLength(1)
    expect((await outputSchemas(root)).entries.map((e) => e.status)).toEqual(["current"])
  }, 90_000)

  test("formatting the generated schema by hand keeps it current; deleting the marker hands it over", async () => {
    const root = project({ "routes/me.backend.ts": initial })
    await outputSchemas(root, { write: true })
    const generated = read(root, "routes/me.backend.ts")
    writeFileSync(
      join(root, "routes/me.backend.ts"),
      generated.replace("t.object({\n  name: t.string(),\n})", "t.object({ name: t.string() });"),
    )
    expect((await outputSchemas(root)).entries.map((e) => e.status)).toEqual(["current"])
    writeFileSync(
      join(root, "routes/me.backend.ts"),
      read(root, "routes/me.backend.ts").replace(/\/\/ nifra:generated.*\n/, ""),
    )
    expect((await outputSchemas(root)).entries.map((e) => e.status)).toEqual(["declared"])
  }, 60_000)

  test("a generated schema whose return type turns any is reported unchecked, never passed", async () => {
    const root = project({
      "routes/me.backend.ts": initial,
      "routes/me.tsx": "export default () => null\n",
    })
    await outputSchemas(root, { write: true })
    writeFileSync(
      join(root, "routes/me.backend.ts"),
      read(root, "routes/me.backend.ts").replace("({ name: 'Ada' })", "JSON.parse('{}')"),
    )
    const check = await collectCheckResult(root, { lintsOnly: true })
    const findings = check.diagnostics.filter((d) => d.code === "NF-C033")
    expect(findings.map((d) => d.severity)).toEqual(["warning"])
    expect(findings[0]?.message).toContain(
      "generated loaderOutput was not checked: the loader's return type is any",
    )
  }, 60_000)

  test("a generated schema over an annotated loader is reported unchecked, never passed", async () => {
    const root = project({
      "routes/me.backend.ts": initial,
      "routes/me.tsx": "export default () => null\n",
    })
    await outputSchemas(root, { write: true })
    writeFileSync(
      join(root, "routes/me.backend.ts"),
      read(root, "routes/me.backend.ts").replace(
        "export const loader = () => ({ name: 'Ada' })",
        "type Loader = () => { name: string }\nexport const loader: Loader = () => ({ name: 'Ada' })",
      ),
    )
    const { entries } = await outputSchemas(root)
    expect(entries.map((e) => e.status)).toEqual(["unreadable"])
    expect(entries[0]?.reason).toContain("loader has a type annotation")
    const check = await collectCheckResult(root, { lintsOnly: true })
    const findings = check.diagnostics.filter((d) => d.code === "NF-C033")
    expect(findings.map((d) => d.severity)).toEqual(["warning"])
    expect(findings[0]?.message).toContain("generated loaderOutput was not checked: loader has")
  }, 60_000)
})

describe("a hand-written schema", () => {
  test("is never rewritten, and its entry names the returned fields it drops", async () => {
    const source = [
      'import { t } from "@nifrajs/schema"',
      "export const loaderOutput = t.object({",
      "  user: t.object({ name: t.string() }),",
      "  items: t.array(t.object({ id: t.string() })),",
      "  extra: t.json(),",
      "})",
      "export const loader = () => ({",
      "  user: { name: 'Ada', email: 'a@x' },",
      "  items: [{ id: '1', secretNote: 'x' }],",
      "  extra: { anything: { goes: 1 } },",
      "  debug: true,",
      "})",
      "",
    ].join("\n")
    const root = project({ "routes/me.backend.ts": source })
    const report = await outputSchemas(root, { write: true })
    expect(report.entries).toEqual([
      {
        file: "routes/me.backend.ts",
        line: 2,
        schema: "loaderOutput",
        status: "declared",
        generated: false,
        dropped: ["user.email", "items[].secretNote", "debug"],
      },
    ])
    expect(report.ok).toBe(true)
    expect(read(root, "routes/me.backend.ts")).toBe(source)
  }, 60_000)
})

describe("shapes", () => {
  test("undeclaredPaths treats a union by its best match and t.json as admitting everything", () => {
    const returned = {
      kind: "object",
      fields: [
        { name: "kind", optional: false, shape: { kind: "literal", value: "a" } },
        { name: "a", optional: false, shape: { kind: "string" } },
        { name: "blob", optional: false, shape: { kind: "object", fields: [] } },
      ],
    } as const
    const declared = {
      kind: "union",
      members: [
        {
          kind: "object",
          fields: [
            { name: "kind", optional: false, shape: { kind: "literal", value: "a" } },
            { name: "a", optional: false, shape: { kind: "string" } },
            { name: "blob", optional: false, shape: { kind: "json" } },
          ],
        },
        {
          kind: "object",
          fields: [{ name: "kind", optional: false, shape: { kind: "literal", value: "b" } }],
        },
        { kind: "null" },
      ],
    } as const
    expect(undeclaredPaths(returned, declared)).toEqual([])
    expect(undeclaredPaths(returned, declared.members[1])).toEqual(["a", "blob"])
  })

  test("schemaSource quotes keys that are not identifiers and reads a tuple as an array", () => {
    expect(
      schemaSource({
        kind: "object",
        fields: [
          {
            name: "pair",
            optional: false,
            shape: { kind: "tuple", items: [{ kind: "string" }, { kind: "number" }] },
          },
          { name: "a-b", optional: true, shape: { kind: "record", values: { kind: "boolean" } } },
        ],
      }),
    ).toBe(
      't.object({\n  pair: t.array(t.union([t.number(), t.string()])),\n  "a-b": t.optional(t.record(t.boolean())),\n})',
    )
  })
})
