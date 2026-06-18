import { describe, expect, test } from "bun:test"
import { csrf } from "../src/index.ts"

/** Resolve the middleware's onRequest once (it's always defined here). */
const handlerOf = (origins?: string[]) => {
  const mw = csrf(origins ? { origins } : {})
  const onRequest = mw.onRequest
  if (onRequest === undefined) throw new Error("csrf must define onRequest")
  return (method: string, headers: Record<string, string>, url = "https://app.example/x") =>
    onRequest(new Request(url, { method, headers }))
}

describe("csrf — Origin/Referer check", () => {
  const run = handlerOf(["https://app.example"])

  test("safe methods always pass", async () => {
    expect(await run("GET", {})).toBeUndefined()
    expect(await run("HEAD", {})).toBeUndefined()
    expect(await run("OPTIONS", {})).toBeUndefined()
  })

  test("unsafe + a matching Origin passes; a mismatch is 403", async () => {
    expect(await run("POST", { origin: "https://app.example" })).toBeUndefined()
    const bad = (await run("POST", { origin: "https://evil.com" })) as Response
    expect(bad.status).toBe(403)
    expect(await bad.json()).toEqual({ ok: false, error: "csrf_failed" })
  })

  test("PUT/PATCH/DELETE are also checked", async () => {
    for (const m of ["PUT", "PATCH", "DELETE"]) {
      expect(((await run(m, { origin: "https://evil.com" })) as Response).status).toBe(403)
      expect(await run(m, { origin: "https://app.example" })).toBeUndefined()
    }
  })

  test("falls back to the Referer origin when Origin is absent", async () => {
    expect(await run("POST", { referer: "https://app.example/page" })).toBeUndefined()
    expect(((await run("POST", { referer: "https://evil.com/x" })) as Response).status).toBe(403)
    expect(((await run("POST", { referer: "not a url" })) as Response).status).toBe(403) // malformed
  })

  test("an unsafe request with neither Origin nor Referer is rejected (fail closed)", async () => {
    expect(((await run("POST", {})) as Response).status).toBe(403)
  })
})

describe("csrf — same-origin default (no origins configured)", () => {
  const run = handlerOf()

  test("derives the allowed origin from the request URL", async () => {
    expect(
      await run("POST", { origin: "https://self.example" }, "https://self.example/x"),
    ).toBeUndefined()
    const bad = (await run(
      "POST",
      { origin: "https://other.example" },
      "https://self.example/x",
    )) as Response
    expect(bad.status).toBe(403)
  })
})
