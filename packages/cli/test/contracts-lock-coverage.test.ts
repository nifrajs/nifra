import { afterAll, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { findCommandSpec } from "../src/command-catalog.ts"
import {
  blindLockEntries,
  type ContractsLock,
  checkContractsLock,
  parseContractsLock,
  snapshotContractsReport,
} from "../src/contracts.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

/**
 * A schema reflection cannot read is locked as `null`, which guards nothing. Snapshot says so, and
 * check tells a lock that never covered a side apart from a schema that changed.
 */
const ROOT = createFixtureRoot("tmp-contracts-coverage")
afterAll(() => removeFixtureRoot(ROOT))

// A Standard Schema with no JSON Schema of its own: it validates, but reflection reads nothing.
const OPAQUE =
  'const opaque = { "~standard": { version: 1, vendor: "opaque", validate: (value: unknown) => ({ value }) } }'

let apps = 0
async function app(route: string, lock?: ContractsLock): Promise<string> {
  const dir = join(ROOT, `app-${++apps}`)
  await mkdir(dir, { recursive: true })
  writeAppFile(
    dir,
    "backend/app.ts",
    [
      'import { server } from "@nifrajs/core"',
      'import { t } from "@nifrajs/schema"',
      OPAQUE,
      `export const backend = server()${route}`,
    ].join("\n"),
  )
  if (lock !== undefined) await writeFile(join(dir, "contracts.lock.json"), JSON.stringify(lock))
  return dir
}

const POST_OPAQUE = '.post("/kites", { body: opaque }, () => ({ ok: true }))'
const POST_READ = '.post("/kites", { body: t.object({ name: t.string() }) }, () => ({ ok: true }))'

test("snapshot names each route whose declared schema it locks as null", async () => {
  const dir = await app(POST_OPAQUE)
  const { lock, unreflected } = await snapshotContractsReport(dir)
  expect(unreflected).toEqual([{ route: "POST /kites", parts: ["body"] }])
  expect(await blindLockEntries(lock)).toEqual([
    { route: "POST /kites", sides: ["request", "response"] },
  ])
  const spec = findCommandSpec("contracts")
  if (spec === undefined) throw new Error("[test] no contracts command")
  const input = spec.input.parse({ action: "snapshot" })
  expect(spec.render(await spec.run(input, { cwd: dir }), input).join("\n")).toContain(
    "⚠ POST /kites: body declares a schema nifra cannot read, locked as null",
  )
})

/** The same lock as a release before parts were recorded wrote it: side digests only. */
function sidesOnly(lock: ContractsLock): ContractsLock {
  const routes = Object.entries(lock.routes).map(([key, { request, response }]) => [
    key,
    { request, response },
  ])
  return { ...lock, routes: Object.fromEntries(routes) }
}

test("a part the lock never guarded reads as newly covered, not as a change", async () => {
  const { lock } = await snapshotContractsReport(await app(POST_OPAQUE))
  expect(lock.routes["POST /kites"]?.parts).toEqual({ body: { digest: null } })
  const { diagnostics } = await checkContractsLock(await app(POST_READ, lock))
  expect(diagnostics).toEqual([
    {
      route: "POST /kites",
      kind: "newly-covered",
      sides: ["request"],
      parts: ["body"],
      message: expect.stringContaining(
        "POST /kites body: contracts.lock.json locked the schema declared there as null",
      ),
    },
  ])
})

test("a lock without parts tells a side it never guarded apart from a change", async () => {
  const { lock } = await snapshotContractsReport(await app(POST_OPAQUE))
  const { diagnostics } = await checkContractsLock(await app(POST_READ, sidesOnly(lock)))
  expect(diagnostics).toEqual([
    {
      route: "POST /kites",
      kind: "newly-covered",
      sides: ["request"],
      message: expect.stringContaining(
        "POST /kites request: contracts.lock.json records no schema",
      ),
    },
  ])
})

const route = (body: string, ok: string) =>
  `.post("/kites", { body: t.object({ ${body} }), response: t.object({ ok: ${ok} }) }, () => ({ ok: true }))`

test("a change names its side, its part and the top-level fields that moved", async () => {
  const { lock } = await snapshotContractsReport(
    await app(route("name: t.string()", "t.boolean()")),
  )
  expect(lock.routes["POST /kites"]?.parts?.body?.fields).toEqual({ name: "string" })
  const request = await checkContractsLock(
    await app(route("id: t.number(), name: t.optional(t.string())", "t.boolean()"), lock),
  )
  expect(request.diagnostics).toEqual([
    expect.objectContaining({
      kind: "changed",
      sides: ["request"],
      parts: ["body"],
      message: expect.stringContaining(
        "contract changed for POST /kites (request): body + id: number, - name: string, + name?: string;",
      ),
    }),
  ])
  const response = await checkContractsLock(
    await app(route("name: t.string()", "t.string()"), lock),
  )
  expect(response.diagnostics).toEqual([
    expect.objectContaining({
      kind: "changed",
      sides: ["response"],
      parts: ["response"],
      message: expect.stringContaining("(response): response ok: boolean -> string;"),
    }),
  ])
})

test("a change below the top-level fields says so", async () => {
  const nested = (inner: string) =>
    `.post("/kites", { body: t.object({ tail: t.object({ ${inner} }) }) }, () => ({ ok: true }))`
  const { lock } = await snapshotContractsReport(await app(nested("knots: t.number()")))
  const { diagnostics } = await checkContractsLock(await app(nested("knots: t.string()"), lock))
  expect(diagnostics.map((d) => d.message)).toEqual([
    expect.stringContaining("(request): body changed below its top-level fields;"),
  ])
})

test("headers and cookies are part of the contract", async () => {
  const guarded = (header: string) =>
    `.get("/kites", { headers: t.object({ "x-team": ${header} }), cookies: t.object({ sid: t.string() }) }, () => 1)`
  const { lock } = await snapshotContractsReport(await app(guarded("t.string()")))
  expect(Object.keys(lock.routes["GET /kites"]?.parts ?? {})).toEqual(["headers", "cookies"])
  const { diagnostics } = await checkContractsLock(await app(guarded("t.number()"), lock))
  expect(diagnostics).toEqual([
    expect.objectContaining({
      kind: "changed",
      sides: ["request"],
      parts: ["headers"],
      message: expect.stringContaining("(request): headers x-team: string -> number;"),
    }),
  ])
  const dropped = await checkContractsLock(await app('.get("/kites", () => 1)', lock))
  expect(dropped.diagnostics.map((d) => d.message)).toEqual([
    expect.stringContaining("(request): headers no longer declared; cookies no longer declared;"),
  ])
})

test("a lock without parts still compares by side", async () => {
  const { lock } = await snapshotContractsReport(
    await app(route("name: t.string()", "t.boolean()")),
  )
  const { diagnostics } = await checkContractsLock(
    await app(route("id: t.number()", "t.boolean()"), sidesOnly(lock)),
  )
  expect(diagnostics).toEqual([
    {
      route: "POST /kites",
      kind: "changed",
      sides: ["request"],
      message: expect.stringContaining("contract changed for POST /kites (request);"),
    },
  ])
})

test("a schema declared now in a form nifra cannot read is a change", async () => {
  const { lock } = await snapshotContractsReport(await app('.post("/kites", () => 1)'))
  expect((await checkContractsLock(await app(POST_OPAQUE, lock))).diagnostics).toEqual([
    expect.objectContaining({
      kind: "changed",
      parts: ["body"],
      message: expect.stringContaining("(request): body declared, in a form nifra cannot read;"),
    }),
  ])
})

test("a route added or removed says which", async () => {
  const { lock } = await snapshotContractsReport(await app(POST_READ))
  const { diagnostics } = await checkContractsLock(await app('.get("/health", () => "ok")', lock))
  expect(diagnostics.map((d) => [d.route, d.kind])).toEqual([
    ["GET /health", "added"],
    ["POST /kites", "removed"],
  ])
})

test("two side digests that guard nothing are not compared", async () => {
  const { lock } = await snapshotContractsReport(await app('.post("/kites", () => 1)'))
  expect((await checkContractsLock(await app(POST_OPAQUE, sidesOnly(lock)))).diagnostics).toEqual(
    [],
  )
})

test("a lock part that is neither a digest nor null is refused", () => {
  const entry = { request: "0".repeat(64), response: "0".repeat(64) }
  expect(() =>
    parseContractsLock({ version: 1, routes: { "GET /": { ...entry, parts: { body: {} } } } }),
  ).toThrow("invalid contract part body for GET /")
  expect(() =>
    parseContractsLock({
      version: 1,
      routes: { "GET /": { ...entry, parts: { body: { digest: null, fields: { a: 1 } } } } },
    }),
  ).toThrow("invalid contract part body fields for GET /")
})
