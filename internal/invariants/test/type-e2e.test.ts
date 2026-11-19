/**
 * End-to-end typing of the file-system router. One app is generated from a table of route shapes, its
 * `.nifra/types` are written by the real `writeRouteTypes`, and every adapter's program then compiles
 * consumer files that use the generated types. Each case is one statement; a case that must be refused
 * carries a `@ts-expect-error`, so a refusal that stops happening is TS2578 and fails the gate. The cases
 * are generated from the shapes (route pattern x params x search x loader data), not picked by hand.
 *
 * A case has a phase: the gate enforces those up to `ENFORCED_PHASE`. Later phases still compile and are
 * reported, so running with `TYPE_E2E_PHASE=9` lists every gap still open as a red case.
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import ts from "typescript"
import { compileRoutePattern } from "../../../packages/core/src/router/pattern.ts"
import { filePathToPatterns } from "../../../packages/web/src/manifest.ts"
import { writeRouteTypes } from "../../../packages/web/src/route-types.ts"
import { programDiagnostics, type Reading } from "./helpers/typed-program.ts"

/** The newest phase of `docs/typed-hooks-plan.md` whose cases fail the build. */
const ENFORCED_PHASE = 4
const PHASE = Number(process.env.TYPE_E2E_PHASE ?? ENFORCED_PHASE)

const REPO = resolve(import.meta.dir, "../../..")
const APP = join(REPO, "examples", `.type-e2e-${process.pid}`)

interface Shape {
  readonly name: string
  readonly file: string
  readonly search: boolean
  readonly loader: boolean
}

const SHAPES: readonly Shape[] = [
  { name: "static", file: "reports.tsx", search: true, loader: false },
  { name: "param", file: "users/[id].tsx", search: false, loader: true },
  { name: "optional", file: "[[lang]]/docs.tsx", search: true, loader: false },
  { name: "catchall", file: "files/[...rest].tsx", search: false, loader: false },
  { name: "nested", file: "org/[org]/members/[member].tsx", search: true, loader: true },
]

interface Adapter {
  readonly id: string
  /** The expression that reads a hook's value: a value, an accessor or a ref, by framework. */
  readonly read: (expression: string) => string
}

const ADAPTERS: readonly Adapter[] = [
  { id: "react", read: (e) => e },
  { id: "preact", read: (e) => e },
  { id: "solid", read: (e) => `${e}()` },
  { id: "svelte", read: (e) => `${e}()` },
  { id: "vue", read: (e) => `${e}.value` },
]

interface Case {
  readonly id: string
  readonly phase: number
  readonly file: string
  /** First and last line of the case in its file, a `@ts-expect-error` comment included. */
  readonly lines: readonly [number, number]
}

/** A generated file: its text, and the cases written into it. */
class Source {
  readonly cases: Case[] = []
  private readonly rows: string[] = []
  constructor(
    readonly file: string,
    header: readonly string[],
  ) {
    this.rows.push(...header)
  }
  raw(line: string): void {
    this.rows.push(line)
  }
  /** One statement that must compile (`refused` false) or must be refused. */
  add(id: string, phase: number, refused: boolean, statement: string): void {
    const first = this.rows.length + 1
    if (refused) this.rows.push("// @ts-expect-error - refused by design")
    this.rows.push(statement)
    this.cases.push({ id, phase, file: this.file, lines: [first, this.rows.length] })
  }
  get text(): string {
    return `${this.rows.join("\n")}\n`
  }
}

/** The URL patterns of a shape, with the param names each carries, from the same codec the router uses. */
function patternsOf(shape: Shape): readonly { pattern: string; names: readonly string[] }[] {
  return filePathToPatterns(shape.file).map((pattern) => ({
    pattern,
    names: compileRoutePattern(pattern).paramNames,
  }))
}

const fields = (names: readonly string[], type: string): string =>
  names.length === 0
    ? "Record<string, never>"
    : `{ ${names.map((n) => `readonly ${n}: ${type}`).join("; ")} }`

const SCHEMA_HEADER = [
  'import type { StandardSchemaV1 } from "@nifrajs/core/server"',
  "export const searchSchema: StandardSchemaV1<{ page?: number }, { page: number }> = {",
  '  "~standard": { version: 1, vendor: "gate", validate: () => ({ value: { page: 1 } }) },',
  "}",
]

function routeSources(): Source[] {
  const out: Source[] = []
  for (const shape of SHAPES) {
    const patterns = patternsOf(shape)
    const last = patterns.at(-1)
    if (last === undefined) continue
    const name = basename(shape.file, ".tsx")
    const page = new Source(`routes/${shape.file}`, [
      `import type { Route } from "./+types/${name}"`,
      ...(shape.search ? SCHEMA_HEADER : []),
      "export default function Page(props: Route.ComponentProps): null {",
    ])
    const optional = new Set(last.names.filter((n) => patterns.some((p) => !p.names.includes(n))))
    for (const n of last.names) {
      const required = !optional.has(n)
      page.add(`${shape.name}: props.params.${n} is read`, 1, false, `  void props.params.${n}`)
      if (required) {
        page.add(
          `${shape.name}: props.params.${n} is a string`,
          1,
          false,
          `  { const v: string = props.params.${n}; void v }`,
        )
      }
    }
    // A route without params types them `Record<string, never>`, which lets any key through as `never`.
    page.add(
      `${shape.name}: an undeclared param is refused`,
      last.names.length === 0 ? 3 : 1,
      true,
      "  void props.params.zzNope",
    )
    if (shape.loader) {
      page.add(
        `${shape.name}: props.data has the loaderOutput shape`,
        1,
        false,
        "  { const v: { readonly id: string } = props.data; void v }",
      )
      page.add(
        `${shape.name}: props.data is not assignable to a wrong shape`,
        1,
        true,
        "  { const v: number = props.data; void v }",
      )
      page.add(
        `${shape.name}: props.actionData has the actionOutput shape`,
        1,
        false,
        "  { const v: { readonly saved: boolean } | undefined = props.actionData; void v }",
      )
      page.add(
        `${shape.name}: props.actionData is not assignable to a wrong shape`,
        1,
        true,
        "  { const v: number | undefined = props.actionData; void v }",
      )
    }
    if (shape.search) {
      page.add(
        `${shape.name}: props.search has the searchSchema output`,
        2,
        false,
        "  { const v: { readonly page: number } = props.search; void v }",
      )
      page.add(
        `${shape.name}: props.search is not assignable to a wrong shape`,
        2,
        true,
        "  { const v: { readonly page: string } = props.search; void v }",
      )
    }
    page.raw("  return null")
    page.raw("}")
    out.push(page)
    if (shape.loader) {
      const backend = new Source(`routes/${shape.file.replace(/\.tsx$/, ".backend.ts")}`, [
        `import type { Route } from "./+types/${name}"`,
        'import { t } from "@nifrajs/schema"',
        "export const loaderOutput = t.object({ id: t.string() })",
        "export const actionOutput = t.object({ saved: t.boolean() })",
        "export function cases(): void {",
      ])
      backend.add(
        `${shape.name}: a loader returning the loaderOutput shape compiles`,
        1,
        false,
        '  { const v: Route.Loader = async () => ({ id: "x" }); void v }',
      )
      backend.add(
        `${shape.name}: a loader returning a wrong shape is refused`,
        1,
        true,
        "  { const v: Route.Loader = async () => ({ id: 1 }); void v }",
      )
      backend.add(
        `${shape.name}: an action returning the actionOutput shape compiles`,
        1,
        false,
        "  { const v: Route.Action = async () => ({ saved: true }); void v }",
      )
      backend.add(
        `${shape.name}: an action returning a wrong shape is refused`,
        1,
        true,
        '  { const v: Route.Action = async () => ({ saved: "yes" }); void v }',
      )
      backend.raw("}")
      out.push(backend)
    }
  }
  return out
}

function consumerSource(adapter: Adapter): Source {
  const source = new Source(`consumers/${adapter.id}.ts`, [
    'import { createQueryClient, href, queryKey } from "@nifrajs/web"',
    'import { serverFn } from "@nifrajs/web/fn"',
    'import { formFor } from "@nifrajs/web/forms"',
    'import { server } from "@nifrajs/core"',
    'import { t } from "@nifrajs/schema"',
    `import * as R from "@nifrajs/web-${adapter.id}/router"`,
    `import * as Q from "@nifrajs/web-${adapter.id}/query"`,
    'const app = server().post("/todos", { body: t.object({ text: t.string() }) }, () => ({ ok: true }))',
    "const client = createQueryClient({ now: () => 0 })",
    "void R",
    "void Q",
    "void app",
    "void client",
    "void serverFn",
    "void formFor",
    "void queryKey",
    "void t",
    "export function cases(): void {",
  ])
  for (const shape of SHAPES) {
    for (const { pattern, names } of patternsOf(shape)) {
      const at = `${adapter.id} ${shape.name} ${pattern}`
      const params =
        names.length === 0 ? "" : `, params: { ${names.map((n) => `${n}: "x"`).join(", ")} }`
      const search = shape.search ? '{ page: "x" }' : undefined
      source.add(
        `${at}: href with its params compiles`,
        1,
        false,
        `  void href({ to: "${pattern}"${params} })`,
      )
      source.add(
        `${at}: href to an unknown route is refused`,
        1,
        true,
        '  void href({ to: "/zz-nope" })',
      )
      if (names.length > 0) {
        source.add(
          `${at}: href without its params is refused`,
          1,
          true,
          `  void href({ to: "${pattern}" })`,
        )
        source.add(
          `${at}: href with an undeclared param is refused`,
          1,
          true,
          `  void href({ to: "${pattern}", params: { zzNope: "x" } })`,
        )
      }
      if (search !== undefined) {
        source.add(
          `${at}: href with a wrong search type is refused`,
          1,
          true,
          `  void href({ to: "${pattern}"${params}, search: ${search} })`,
        )
        source.add(
          `${at}: href may omit a search field the schema defaults`,
          3,
          false,
          `  void href({ to: "${pattern}"${params}, search: {} })`,
        )
      }
      const read = (call: string): string => adapter.read(call)
      const paramsType = fields(names, "string")
      source.add(
        `${at}: useParams reads the route's params`,
        2,
        false,
        `  { const v: ${paramsType} = ${read(`R.useParams("${pattern}")`)}; void v }`,
      )
      if (names.length > 0) {
        source.add(
          `${at}: useParams is not assignable to a wrong shape`,
          2,
          true,
          `  { const v: ${fields([...names, "zzNope"], "string")} = ${read(`R.useParams("${pattern}")`)}; void v }`,
        )
      }
      const searchType = shape.search ? "{ readonly page: number }" : "Record<string, unknown>"
      source.add(
        `${at}: useSearch reads the route's search`,
        2,
        false,
        `  { const v: ${searchType} = ${read(`R.useSearch("${pattern}")`)}; void v }`,
      )
      if (shape.search) {
        source.add(
          `${at}: useSearch is not assignable to a wrong shape`,
          2,
          true,
          `  { const v: { readonly page: string } = ${read(`R.useSearch("${pattern}")`)}; void v }`,
        )
      }
    }
  }
  source.add(
    `${adapter.id}: useParams of an unknown route is refused`,
    2,
    true,
    '  void R.useParams("/zz-nope")',
  )
  source.add(
    `${adapter.id}: useSearch of an unknown route is refused`,
    2,
    true,
    '  void R.useSearch("/zz-nope")',
  )
  source.add(`${adapter.id}: a bare useSearch is refused`, 2, true, "  void R.useSearch()")
  source.add(
    `${adapter.id}: useSearch with a schema type argument is refused`,
    2,
    true,
    "  void R.useSearch<{ page: number }>()",
  )
  if (adapter.id === "react") {
    source.add(
      `react: useParams with a shape type argument is refused`,
      2,
      true,
      "  void R.useParams<{ id: string }>()",
    )
  }
  source.add(
    `${adapter.id}: a server function shows the client its output schema, not its return`,
    4,
    true,
    '  { const f = serverFn({ output: t.object({ id: t.string() }) }, async () => ({ id: "x", n: 1 })); const v: { readonly id: string; readonly n: number } = null as unknown as Awaited<ReturnType<typeof f>>; void v }',
  )
  const useQuery = adapter.id === "solid" ? "createQuery" : "useQuery"
  const at = adapter.id
  source.add(
    `${at}: a server function that returns data without an output schema is refused`,
    4,
    true,
    "  void serverFn({}, async () => ({ ok: true }))",
  )
  source.add(
    `${at}: a server function whose return does not fit its output schema is refused`,
    4,
    true,
    "  void serverFn({ output: t.object({ id: t.string() }) }, async () => ({ id: 1 }))",
  )
  source.add(
    `${at}: a server function with nothing to return needs no schema`,
    4,
    false,
    "  void serverFn({}, async () => {})",
  )
  source.add(
    `${at}: formFor binds a route the app declares`,
    4,
    false,
    '  { const f = formFor<typeof app>()("/todos"); const a: "/todos" = f.action; void a; f.field("text") }',
  )
  source.add(
    `${at}: formFor refuses a route the app does not declare`,
    4,
    true,
    '  void formFor<typeof app>()("/zz-nope")',
  )
  source.add(
    `${at}: formFor refuses a method the route does not declare`,
    4,
    true,
    '  void formFor<typeof app>()("/todos", "delete")',
  )
  source.add(
    `${at}: formFor refuses a field the body does not have`,
    4,
    true,
    '  void formFor<typeof app>()("/todos").field("zzNope")',
  )
  source.add(
    `${at}: a typed query key and its fetcher agree`,
    4,
    false,
    "  void Q." + useQuery + '(queryKey<number>(["n"]), async () => 1)',
  )
  source.add(
    `${at}: a typed query key refuses a fetcher of another type`,
    4,
    true,
    "  void Q." + useQuery + '(queryKey<number>(["n"]), async () => "s")',
  )
  source.add(
    `${at}: a plain query key still takes the fetcher's type`,
    4,
    false,
    "  { const q = Q." + useQuery + '(["n"], async () => 1); void q }',
  )
  source.add(
    `${at}: getQueryData reads the type its key carries`,
    4,
    false,
    '  { const v: number | undefined = client.getQueryData(queryKey<number>(["n"])); void v }',
  )
  source.add(
    `${at}: getQueryData refuses a plain key, whose type the caller would have to assert`,
    4,
    true,
    '  void client.getQueryData(["n"])',
  )
  source.add(
    `${at}: setQueryData refuses a value of another type than its key carries`,
    4,
    true,
    '  client.setQueryData(queryKey<number>(["n"]), "s")',
  )
  source.add(
    `${at}: setQueryData takes the type its key carries`,
    4,
    false,
    '  client.setQueryData(queryKey<number>(["n"]), 1)',
  )
  source.raw("}")
  return source
}

const sources = (): Source[] => [...routeSources(), ...ADAPTERS.map(consumerSource)]

/** The adapter's program over these files. */
const diagnosticsOf = (adapter: string, files: readonly string[]): Reading[] =>
  programDiagnostics(APP, adapter, files)

function diagnostics(adapter: string, written: readonly Source[]): Reading[] {
  return diagnosticsOf(adapter, [
    ...written
      .filter((s) => s.file.startsWith("routes/") || s.file === `consumers/${adapter}.ts`)
      .map((s) => join(APP, s.file)),
    join(APP, ".nifra/types/routes.d.ts"),
  ])
}

beforeAll(() => {
  mkdirSync(APP, { recursive: true })
  for (const source of sources()) {
    const path = join(APP, source.file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source.text)
  }
  writeRouteTypes({ appRoot: APP })
})

afterAll(() => rmSync(APP, { recursive: true, force: true }))

/** The cases whose lines hold a diagnostic of this program, by case id. */
function failing(written: readonly Source[], readings: readonly Reading[]): Map<string, string> {
  const failed = new Map<string, string>()
  for (const reading of readings) {
    const owner = written
      .flatMap((s) => s.cases)
      .find(
        (c) => c.file === reading.file && reading.line >= c.lines[0] && reading.line <= c.lines[1],
      )
    failed.set(
      owner?.id ?? `${reading.file}:${reading.line}`,
      `TS${reading.code} ${reading.where.slice(0, 110)}`,
    )
  }
  return failed
}

for (const adapter of ADAPTERS) {
  test(`${adapter.id}: every enforced case compiles or is refused as declared`, () => {
    const written = sources()
    const failed = failing(written, diagnostics(adapter.id, written))
    const cases = written
      .flatMap((s) => s.cases)
      .filter((c) => c.file.startsWith("routes/") || c.file === `consumers/${adapter.id}.ts`)
    const open = cases.filter((c) => failed.has(c.id))
    if (process.env.TYPE_E2E_REPORT !== undefined) {
      for (const c of open) console.log(`[phase ${c.phase}] ${c.id}: ${failed.get(c.id)}`)
    }
    const stray = [...failed].filter(([id]) => !cases.some((c) => c.id === id))
    expect(stray.map(([id, why]) => `${id} ${why}`)).toEqual([])
    expect(open.filter((c) => c.phase <= PHASE).map((c) => `${c.id}: ${failed.get(c.id)}`)).toEqual(
      [],
    )
  }, 180_000)
}

test("an empty route table accepts any pattern with the loose types", () => {
  const source = new Source("consumers/empty.ts", [
    'import * as R from "@nifrajs/web-react/router"',
    "export function cases(): void {",
  ])
  source.add(
    "useSearch reads loosely",
    2,
    false,
    '  { const v: Record<string, unknown> = R.useSearch("/any"); void v }',
  )
  source.add(
    "useParams reads loosely",
    2,
    false,
    '  { const v: Readonly<Record<string, string>> = R.useParams("/any/:x"); void v }',
  )
  source.raw("}")
  mkdirSync(join(APP, "consumers"), { recursive: true })
  writeFileSync(join(APP, source.file), source.text)
  // Only this file: the other consumers load the generated table, which is the thing being left out.
  const found = diagnosticsOf("react", [join(APP, source.file)])
  expect(found.map((r) => `${r.file}:${r.line} TS${r.code} ${r.where}`)).toEqual([])
})

test("the gate sees a case that is accepted when it should be refused, and one that is refused when it should not be", () => {
  const probe = new Source("consumers/probe.ts", ["export function cases(): void {"])
  probe.add("accepted but expected refusal", 1, true, "  { const v: number = 1; void v }")
  probe.add("refused but expected acceptance", 1, false, '  { const v: number = "s"; void v }')
  probe.raw("}")
  mkdirSync(join(APP, "consumers"), { recursive: true })
  writeFileSync(join(APP, probe.file), probe.text)
  const program = ts.createProgram([join(APP, probe.file)], {
    noEmit: true,
    strict: true,
    types: [],
  })
  const readings: Reading[] = ts.getPreEmitDiagnostics(program).flatMap((item) => {
    if (item.file === undefined) return []
    const at = item.file.getLineAndCharacterOfPosition(item.start ?? 0)
    return [{ code: item.code, where: "", line: at.line + 1, file: "consumers/probe.ts" }]
  })
  expect([...failing([probe], readings).keys()].sort()).toEqual([
    "accepted but expected refusal",
    "refused but expected acceptance",
  ])
})
