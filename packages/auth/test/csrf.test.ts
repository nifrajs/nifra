import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { csrf } from "../src/index.ts"

/** Resolve the middleware's onRequest once (it's always defined here). */
const handlerOf = (origins?: string[]) => {
  const mw = csrf(origins ? { origins } : {})
  const onRequest = mw.onRequest
  if (onRequest === undefined) throw new Error("csrf must define onRequest")
  return (method: string, headers: Record<string, string>, url = "https://app.example/x") =>
    onRequest(new Request(url, { method, headers }))
}

describe("csrf - Origin/Referer check", () => {
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

describe("csrf - same-origin default (no origins configured)", () => {
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

describe("csrf - same-origin default", () => {
  const run = handlerOf()

  test("accepts an https page behind a TLS-terminating proxy (http request URL)", async () => {
    expect(
      await run("POST", { origin: "https://app.example" }, "http://app.example/x"),
    ).toBeUndefined()
    expect(
      await run("POST", { referer: "https://app.example/form" }, "http://app.example/x"),
    ).toBeUndefined()
  })

  test("rejects a scheme downgrade and a different host", async () => {
    const downgrade = (await run("POST", { origin: "http://app.example" })) as Response
    expect(downgrade.status).toBe(403)
    const other = (await run("POST", { origin: "https://evil.example" })) as Response
    expect(other.status).toBe(403)
  })
})

describe("csrf - stacking", () => {
  test("a stricter csrf() after a broader one applies too", async () => {
    const app = server()
      .use(csrf({ origins: ["https://app.example", "https://partner.example"] }))
      .use(csrf({ origins: ["https://app.example"] }))
      .post("/x", () => "ok")
    const post = (origin: string) =>
      app.fetch(new Request("https://app.example/x", { method: "POST", headers: { origin } }))
    expect((await post("https://app.example")).status).toBe(200)
    expect((await post("https://partner.example")).status).toBe(403)
  })
})
