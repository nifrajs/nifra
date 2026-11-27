import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serveStatic } from "../src/index.ts"
import { createStaticResolver } from "../src/transport.ts"

let dir = ""

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nifra-static-resolver-"))
  await writeFile(join(dir, "hello.txt"), "resolver-hello")
})

afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true })
})

describe("createStaticResolver (@nifrajs/node/transport)", () => {
  test("rejects non-function static options", () => {
    expect(() => createStaticResolver("invalid")).toThrow(TypeError)
  })

  test("serves static mounts for GET/HEAD with optional headers and HTTP/2 authority", async () => {
    const resolver = createStaticResolver(serveStatic({ dir, prefix: "/", fallthrough: true }))
    const headers = new Map<string, string>([
      ["host", "example.com"],
      ["range", "bytes=0-7"],
    ])
    const ranged = await resolver(
      "GET",
      "/hello.txt",
      (name) => headers.get(name.toLowerCase()) ?? null,
      () => new Request("http://example.com/hello.txt"),
      "h2.authority.test",
    )
    expect(ranged?.kind).toBe("body")
    expect(ranged !== undefined && ranged.kind === "body" && ranged.status).toBe(206)

    const headOut = await resolver(
      "HEAD",
      "/hello.txt",
      () => null,
      () => new Request("http://example.com/hello.txt", { method: "HEAD" }),
      "h2.authority.test",
    )
    expect(headOut?.kind).toBe("body")
    expect(headOut !== undefined && headOut.kind === "body" && headOut.status).toBe(200)

    const postOut = resolver(
      "POST",
      "/hello.txt",
      () => null,
      () => new Request("http://example.com/hello.txt", { method: "POST" }),
    )
    expect(postOut).toBeUndefined()
  })

  test("wraps sync and async custom static handler functions", async () => {
    const syncResolver = createStaticResolver((req: Request) =>
      new URL(req.url).pathname === "/hit" ? new Response("sync-hit") : undefined,
    )
    const miss = syncResolver(
      "GET",
      "/miss",
      () => null,
      () => new Request("http://localhost/miss"),
    )
    expect(miss).toBeUndefined()
    const hit = syncResolver(
      "GET",
      "/hit",
      () => null,
      () => new Request("http://localhost/hit"),
    )
    expect(hit !== undefined && !(hit instanceof Promise) && hit.kind === "response").toBe(true)

    const asyncResolver = createStaticResolver(async (req: Request) =>
      new URL(req.url).pathname === "/async" ? new Response("async-hit") : undefined,
    )
    const asyncMiss = await asyncResolver(
      "GET",
      "/nope",
      () => null,
      () => new Request("http://localhost/nope"),
    )
    expect(asyncMiss).toBeUndefined()
    const asyncHit = await asyncResolver(
      "GET",
      "/async",
      () => null,
      () => new Request("http://localhost/async"),
    )
    expect(asyncHit?.kind).toBe("response")
  })
})
