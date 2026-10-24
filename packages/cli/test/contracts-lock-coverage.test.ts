import { afterAll, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { findCommandSpec } from "../src/command-catalog.ts"
import {
  blindLockEntries,
  type ContractsLock,
  checkContractsLock,
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

test("a side the lock never guarded reads as newly covered, not as a change", async () => {
  const { lock } = await snapshotContractsReport(await app(POST_OPAQUE))
  const { diagnostics } = await checkContractsLock(await app(POST_READ, lock))
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

test("a change names its side", async () => {
  const route = (body: string, ok: string) =>
    `.post("/kites", { body: t.object({ ${body} }), response: t.object({ ok: ${ok} }) }, () => ({ ok: true }))`
  const { lock } = await snapshotContractsReport(
    await app(route("name: t.string()", "t.boolean()")),
  )
  const request = await checkContractsLock(await app(route("id: t.number()", "t.boolean()"), lock))
  expect(request.diagnostics).toEqual([
    expect.objectContaining({
      kind: "changed",
      sides: ["request"],
      message: expect.stringContaining("contract changed for POST /kites (request);"),
    }),
  ])
  const response = await checkContractsLock(
    await app(route("name: t.string()", "t.string()"), lock),
  )
  expect(response.diagnostics).toEqual([
    expect.objectContaining({ kind: "changed", sides: ["response"] }),
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

test("two digests that guard nothing are not compared", async () => {
  const { lock } = await snapshotContractsReport(await app('.post("/kites", () => 1)'))
  expect((await checkContractsLock(await app(POST_OPAQUE, lock))).diagnostics).toEqual([])
})
