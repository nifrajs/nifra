import { describe, expect, test } from "bun:test"
import { type AnyServer, server, silentLogger } from "@nifrajs/core"
import { nodeDirect } from "@nifrajs/core/node-direct"
import { conditionalResponse, cors, requestId, timing } from "../src/index.ts"

/**
 * Response middleware writes per-request headers (a request id, the reflected origin, timings). On a
 * Response a handler hands to many requests, those writes land on this request's copy: the next
 * request never sees them, and the shared object stays as its author built it.
 */

type Send = (app: AnyServer, request: Request) => Promise<Headers>
const LANES: ReadonlyArray<readonly [string, Send]> = [
  ["app.fetch", async (app, request) => (await app.fetch(request)).headers],
  [
    "app.resolveNode",
    async (app, request) => {
      const outcome = await app.resolveNode(request)
      if (outcome.kind === "response") return outcome.response.headers
      const headers = new Headers()
      for (const [name, value] of Object.entries(outcome.headers ?? {})) {
        for (const one of typeof value === "string" ? [value] : value) headers.append(name, one)
      }
      return headers
    },
  ],
]

const call = (id: string, origin: string): Request =>
  new Request("http://t/empty", { headers: { "x-request-id": id, origin } })

for (const [lane, send] of LANES) {
  describe(`response middleware on a shared Response - ${lane}`, () => {
    test("each request gets its own id and origin; the shared Response is untouched", async () => {
      const empty = new Response(null, { status: 204 })
      const app = server({ logger: silentLogger })
        .use(nodeDirect())
        .use(requestId())
        .use(cors({ origin: ["https://a.test", "https://b.test"] }))
        .use(timing())
        .get("/empty", () => empty)
      const first = await send(app, call("first", "https://a.test"))
      const second = await send(app, call("second", "https://b.test"))
      expect(first.get("x-request-id")).toBe("first")
      expect(first.get("access-control-allow-origin")).toBe("https://a.test")
      expect(second.get("x-request-id")).toBe("second")
      expect(second.get("access-control-allow-origin")).toBe("https://b.test")
      expect([...empty.headers]).toEqual([])
    })
  })
}

describe("conditionalResponse on a shared body-less Response", () => {
  test("validators land on a copy", () => {
    const shared = new Response(null, { status: 200 })
    const out = conditionalResponse(new Request("http://t/"), shared, { etag: '"v1"' })
    expect(out).not.toBe(shared)
    expect(out.headers.get("etag")).toBe('"v1"')
    expect([...shared.headers]).toEqual([])
  })
})
