import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ssrTablesSlice } from "./site-slice.ts"
import { createStaticFetch } from "./static-node-handler.ts"
import { staticFileFor } from "./static-path.ts"
import { ALL_TABLE_SECTIONS } from "./targets.ts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("cacheable SSR benchmark coverage", () => {
  test("every UI adapter has a Node SSG row and React also has a warmed Node ISR row", () => {
    const targets = ALL_TABLE_SECTIONS.flatMap((section) => section.targets)
    expect(targets).toHaveLength(33)
    expect(new Set(targets.map((target) => target.port)).size).toBe(targets.length)
    const tables = ALL_TABLE_SECTIONS.filter((section) => section.label.includes("Table B"))
    expect(tables).toHaveLength(5)
    for (const table of tables) {
      for (const runtime of ["bun", "node"]) {
        expect(
          table.targets.some(
            (target) =>
              target.name.startsWith("nifra+") &&
              target.name.includes("SSG") &&
              target.runtime === runtime,
          ),
        ).toBe(true)
      }
    }
    const react = tables.find((table) => table.label.startsWith("React"))
    const nodeIsr = react?.targets.find(
      (target) =>
        target.runtime === "node" &&
        target.name.startsWith("nifra+") &&
        target.name.includes("ISR"),
    )
    expect(nodeIsr?.warmupCache).toBe(true)
    expect(nodeIsr?.validate).toEqual({ rootId: "root", text: "Item 50", liCount: 50 })
  })

  test("website rows retain SSG/ISR labels for the Node entries", () => {
    const rows = ALL_TABLE_SECTIONS.filter((section) => section.label.includes("Table B")).flatMap(
      (section) =>
        section.targets
          .filter((target) => target.runtime === "node" && target.name.startsWith("nifra+"))
          .map((target) => ({
            framework: section.label.split(" - ")[0] ?? "",
            target,
            result: { rps: 1, p50ms: 1, p99ms: 2, payloadRaw: 1024, payloadGzip: 512 },
          })),
    )
    const rendered = ssrTablesSlice(rows).flatMap((table) => table.rows)
    expect(rendered).toHaveLength(6)
    expect(rendered.every((row) => / (SSG|ISR) \(Node\)$/.test(row.name))).toBe(true)
    expect(rendered.every((row) => row.runtime === "node" && row.nifra === true)).toBe(true)
  })
})

describe("portable static benchmark files", () => {
  test("both runtimes share document and flattened asset paths", () => {
    expect(staticFileFor("/dist", "/")).toBe("/dist/index.html")
    expect(staticFileFor("/dist", "/assets/client.js")).toBe("/dist/client.js")
    expect(staticFileFor("/dist", "/nested/index.html")).toBe("/dist/nested/index.html")
    for (const path of [
      "relative",
      "/../secret",
      "/assets/",
      "/assets/nested/client.js",
      "/assets/../secret",
    ]) {
      expect(staticFileFor("/dist", path)).toBeUndefined()
    }
  })

  test("Node serves current disk contents, correct MIME types, and missing-file 404s", async () => {
    const dist = await mkdtemp(join(tmpdir(), "nifra-ssg-node-"))
    directories.push(dist)
    await writeFile(join(dist, "index.html"), "<h1>First</h1>")
    await writeFile(join(dist, "client.js"), "export const ok = true")
    await mkdir(join(dist, "directory"))
    const fetch = createStaticFetch(dist)
    const document = await fetch(new Request("http://localhost/"))
    expect(document.status).toBe(200)
    expect(document.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(await document.text()).toBe("<h1>First</h1>")
    await writeFile(join(dist, "index.html"), "<h1>Second</h1>")
    expect(await (await fetch(new Request("http://localhost/"))).text()).toBe("<h1>Second</h1>")
    const asset = await fetch(new Request("http://localhost/assets/client.js"))
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(await asset.text()).toBe("export const ok = true")
    for (const path of ["/missing", "/directory", "/assets/nested/client.js"]) {
      expect((await fetch(new Request(`http://localhost${path}`))).status).toBe(404)
    }
  })
})
