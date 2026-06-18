import { describe, expect, test } from "bun:test"
import { type Middleware, server } from "@nifrajs/core"
import { combine, namedCombine, poweredBy } from "../src/index.ts"

describe("combine()", () => {
  test("applies multiple middleware/plugins as one bundle", async () => {
    const app = server()
      .use(combine(poweredBy({ value: "bundle" })))
      .get("/", () => ({ ok: true }))

    expect((await app.fetch(new Request("http://x/"))).headers.get("x-powered-by")).toBe("bundle")
  })

  test("named bundles are idempotent", async () => {
    let calls = 0
    const counter: Middleware = {
      name: "counter",
      onResponse(res) {
        calls += 1
        return res
      },
    }
    const bundle = namedCombine("ops", counter)
    const app = server()
      .use(bundle)
      .use(bundle)
      .get("/", () => ({ ok: true }))

    await app.fetch(new Request("http://x/"))
    expect(calls).toBe(1)
  })

  test("validates named bundles", () => {
    expect(() => namedCombine("")).toThrow(/name/)
  })
})
