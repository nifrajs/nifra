import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { serveStatic } from "../src/serve-static.ts"
import { server } from "../src/server.ts"
import {
  STATIC_MOUNT_CASES,
  STATIC_MOUNTS_APP,
  staticMountAnswer,
  staticMounts,
} from "./static-mounts.ts"

let running: { readonly port: number; stop(): unknown } | undefined
let base = ""

beforeAll(() => {
  running = server()
    .get("/*", (c) => c.text(STATIC_MOUNTS_APP))
    .post("/*", (c) => c.text(STATIC_MOUNTS_APP))
    .listen(0, { hostname: "127.0.0.1", static: serveStatic(staticMounts()) })
  base = `http://127.0.0.1:${running.port}`
})

afterAll(async () => {
  await running?.stop()
})

describe("serveStatic through listen()", () => {
  for (const [name, path, method, expected] of STATIC_MOUNT_CASES) {
    test(name, async () => {
      expect(await staticMountAnswer(base, path, method, expected)).toEqual(expected)
    })
  }
})

test("a request no mount takes is passed on synchronously", () => {
  const handler = serveStatic(staticMounts())
  expect(handler(new Request("http://x/elsewhere"))).toBeUndefined()
  expect(handler(new Request("http://x/x/shared.txt", { method: "POST" }))).toBeUndefined()
})

test("allow sees the request's host and its path as sent", async () => {
  const seen: [string, string][] = []
  const handler = serveStatic({
    dir: new URL("./fixtures/static-mounts/one/", import.meta.url),
    prefix: "/",
    allow: (host, pathname) => {
      seen.push([host, pathname])
      return false
    },
  })
  expect(handler(new Request("http://app.example:8080/only%2Done.txt?q=1"))).toBeUndefined()
  expect(seen).toEqual([["app.example:8080", "/only%2Done.txt"]])
})

test("a mount over a directory made after it serves once the directory exists", async () => {
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const parent = mkdtempSync(join(tmpdir(), "nifra-serve-static-"))
  try {
    const handler = serveStatic({ dir: join(parent, "later"), prefix: "/" })
    expect((await handler(new Request("http://x/a.txt")))?.status).toBe(404)
    mkdirSync(join(parent, "later"))
    writeFileSync(join(parent, "later", "a.txt"), "made later")
    expect(await (await handler(new Request("http://x/a.txt")))?.text()).toBe("made later")
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
