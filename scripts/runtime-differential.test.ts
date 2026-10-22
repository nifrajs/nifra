import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import fc from "fast-check"
import { INTERNAL_SENTINEL } from "./fixtures/runtime-differential/app.ts"
import { type Case, caseArbitrary, parseCase } from "./runtime-differential/arbitraries.ts"
import type { LaneName } from "./runtime-differential/lanes.ts"
import { canonical, judge, unknownStderr } from "./runtime-differential/oracle.ts"
import {
  encodeRequest,
  exchange,
  type Outcome,
  parseResponse,
  toRequest,
  type WireRequest,
} from "./runtime-differential/wire.ts"

const text = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes)
const bytes = (value: string) => new TextEncoder().encode(value)
const get = (
  target: string,
  headers: [string, string][] = [["Host", "127.0.0.1"]],
): WireRequest => ({
  method: "GET",
  target,
  headers,
  body: "",
  framing: { kind: "none" },
})
const response = (status: number, body = "", headers: [string, string][] = []): Outcome => ({
  kind: "response",
  status,
  headers: [["x-differential", "1"], ...headers],
  body: bytes(body),
})
const caseOf = (
  request: WireRequest,
  route: Case["route"] = "root",
  refusable: string[] = [],
): Case => ({
  route,
  request,
  refusable,
})

describe("encodeRequest", () => {
  test("frames the body as declared and always asks to close", () => {
    const post = { ...get("/x"), method: "POST", body: "héllo" }
    expect(text(encodeRequest({ ...post, framing: { kind: "length" } }))).toBe(
      "POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 6\r\nConnection: close\r\n\r\nhÃ©llo",
    )
    expect(text(encodeRequest({ ...post, framing: { kind: "chunked" } }))).toEndWith(
      "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n6\r\nhÃ©llo\r\n0\r\n\r\n",
    )
    expect(text(encodeRequest({ ...post, framing: { kind: "declared", value: "1e3" } }))).toContain(
      "Content-Length: 1e3\r\n",
    )
  })
})

describe("parseResponse", () => {
  test("reads a Content-Length body, a chunked body and a bodiless HEAD", () => {
    const sized = parseResponse(
      bytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-A: b\r\n\r\nhiEXTRA"),
      "GET",
      false,
    )
    expect(sized).toEqual({
      kind: "complete",
      response: {
        status: 200,
        headers: [
          ["content-length", "2"],
          ["x-a", "b"],
        ],
        body: bytes("hi"),
      },
    })
    const chunked = parseResponse(
      bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n1\r\nc\r\n0\r\n\r\n"),
      "GET",
      false,
    )
    expect(chunked.kind === "complete" && text(chunked.response.body)).toBe("abc")
    expect(
      parseResponse(bytes("HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n"), "HEAD", false).kind,
    ).toBe("complete")
  })

  test("waits for more bytes until the server closes, then reads what came", () => {
    const partial = bytes("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab")
    expect(parseResponse(partial, "GET", false)).toEqual({ kind: "incomplete" })
    expect(parseResponse(partial, "GET", true)).toEqual({
      kind: "malformed",
      reason: "truncated body",
    })
    const unframed = parseResponse(bytes("HTTP/1.1 200 OK\r\n\r\nall of it"), "GET", true)
    expect(unframed.kind === "complete" && text(unframed.response.body)).toBe("all of it")
  })

  test("skips an interim 100 Continue, and one alone is no answer", () => {
    const final = parseResponse(
      bytes("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n"),
      "POST",
      false,
    )
    expect(final.kind === "complete" && final.response.status).toBe(204)
    expect(parseResponse(bytes("HTTP/1.1 100 Continue\r\n\r\n"), "POST", true)).toEqual({
      kind: "interim-only",
    })
    expect(parseResponse(bytes("garbage\r\n\r\n"), "GET", true).kind).toBe("malformed")
  })
})

describe("exchange", () => {
  test("a server that never answers is a timeout, not a hung harness", async () => {
    const silent = createServer(() => {})
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve))
    const address = silent.address()
    if (address === null || typeof address === "string") throw new Error("no TCP address")
    const port = address.port
    try {
      expect(await exchange(port, get("/"), 50)).toEqual({ kind: "timeout", received: 0 })
    } finally {
      silent.close()
    }
  })

  test("a port nobody listens on is a closed connection once every attempt is refused", async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const address = probe.address()
    if (address === null || typeof address === "string") throw new Error("no TCP address")
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    expect(await exchange(address.port, get("/"), 5_000)).toEqual({
      kind: "closed",
      detail: "ECONNREFUSED",
    })
  })

  test("reads a real answer off the socket", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok", { status: 201 }),
    })
    try {
      if (server.port === undefined) throw new Error("no port")
      const outcome = await exchange(server.port, get("/"), 5_000)
      expect(outcome.kind === "response" && [outcome.status, text(outcome.body)]).toEqual([
        201,
        "ok",
      ])
    } finally {
      server.stop(true)
    }
  })
})

describe("toRequest", () => {
  test("sits out what only a socket can carry", () => {
    expect(toRequest({ ...get("/"), framing: { kind: "declared", value: "3" } })).toBe(
      "declared length differs from the body",
    )
    expect(toRequest(get("/café"))).toBe("target has bytes a URL would re-encode")
    expect(
      toRequest(
        get("/", [
          ["Host", "a"],
          ["Host", "b"],
        ]),
      ),
    ).toBe("not exactly one Host")
    expect(toRequest(get("/", [["Host", "x/users/7#"]]))).toBe("Host is not an authority")
  })

  test("keeps `//` a path and a header value its wire bytes", () => {
    const built = toRequest(
      get("//files/a", [
        ["Host", "127.0.0.1"],
        ["x-caller", "café"],
      ]),
    )
    if (typeof built === "string") throw new Error(built)
    expect(new URL(built.url).pathname).toBe("//files/a")
    expect(built.headers.get("x-caller")).toBe("cafÃ©")
  })
})

describe("judge", () => {
  const all = (outcome: Outcome) =>
    new Map<LaneName, Outcome>([
      ["bun-serve", outcome],
      ["node", outcome],
      ["deno", outcome],
    ])

  test("agreeing lanes pass; transport headers are not part of the answer", () => {
    const withDate = response(200, "{}", [
      ["date", "Mon"],
      ["connection", "close"],
    ])
    expect(canonical(withDate)).toBe(canonical(response(200, "{}")))
    expect(judge(caseOf(get("/")), all(response(200, "{}"))).violations).toEqual([])
  })

  test("a 5xx to client input, a leak and a disagreement are each a violation", () => {
    const fault = judge(caseOf(get("/")), all(response(500)))
    expect(fault.violations.map((violation) => violation.signature)).toEqual([
      "server-error root 500 [bun-serve,node,deno]",
    ])
    expect(judge(caseOf(get("/error/throw"), "errorThrow"), all(response(500))).violations).toEqual(
      [],
    )
    const leaked = judge(
      caseOf(get("/")),
      all(response(200, `boom ${INTERNAL_SENTINEL} at run (/srv/app.ts:3:1)`)),
    )
    expect(leaked.violations.map((violation) => violation.signature.split(" ")[2])).toEqual([
      "sentinel",
      "stack-frame",
      "file-path",
      "source-location",
    ])
    const differing = new Map<LaneName, Outcome>([
      ["bun-serve", response(200, "a")],
      ["node", response(200, "b")],
    ])
    expect(judge(caseOf(get("/")), differing).violations[0]?.signature).toBe(
      "difference root bun-serve=200* node=200*",
    )
  })

  test("what the request carried in is no leak", () => {
    const echoed = judge(
      caseOf(get("/files/node_modules/a.ts:1")),
      all(response(200, '{"rest":"node_modules/a.ts:1"}')),
    )
    expect(echoed.violations).toEqual([])
  })

  test("a refusal by a runtime's own parser is excused only when every lane that took it agrees", () => {
    const refusable = caseOf(get("/"), "root", ["method outside llhttp"])
    const refusedOnce = new Map<LaneName, Outcome>([
      ["bun-serve", { kind: "closed", detail: "end" }],
      ["node", response(400)],
      ["deno", response(405, "{}")],
    ])
    expect(judge(refusable, refusedOnce)).toEqual({ violations: [], excusedBy: ["parser-refusal"] })
    const split = new Map<LaneName, Outcome>([
      ...refusedOnce,
      ["deno", response(200, "{}")],
      ["bun-fetch", response(200, "[]")],
    ])
    expect(judge(refusable, split).violations[0]?.kind).toBe("difference")
  })

  test("an answer without the app's mark is the wrangler front's, held to nothing", () => {
    const front: Outcome = {
      kind: "response",
      status: 500,
      headers: [],
      body: bytes("at x (/a.ts:1)"),
    }
    const outcomes = new Map<LaneName, Outcome>([
      ["bun-serve", response(200, "{}")],
      ["workerd", front],
    ])
    expect(judge(caseOf(get("/")), outcomes)).toEqual({
      violations: [],
      excusedBy: ["U2 workerd-front-answer"],
    })
    const deno500 = new Map<LaneName, Outcome>([...outcomes, ["deno", response(500)]])
    expect(
      judge(caseOf(get("/")), deno500).violations.map((violation) => violation.signature),
    ).toEqual(["server-error root 500 [deno]", "difference root bun-serve=200 deno=500"])
  })

  test("a documented spelling is rewritten before lanes are compared", () => {
    const json = (type: string) => response(200, "{}", [["content-type", type]])
    const outcomes = new Map<LaneName, Outcome>([
      ["bun-serve", json("application/json;charset=utf-8")],
      ["node", json("application/json")],
    ])
    expect(judge(caseOf(get("/")), outcomes)).toEqual({
      violations: [],
      excusedBy: ["json-content-type-is-the-runtimes"],
    })
  })

  test("an exposed open finding is reported instead of excused", () => {
    const echoed = caseOf(
      get("/whoami", [
        ["Host", "127.0.0.1"],
        ["x-caller", "café"],
      ]),
    )
    const outcomes = new Map<LaneName, Outcome>([
      ["bun-serve", response(200, '{"caller":"cafÃ©"}')],
      ["deno", response(200, '{"caller":"cafÃ©"}')],
      ["workerd", response(200, '{"caller":"café"}')],
    ])
    expect(judge(echoed, outcomes).excusedBy).toEqual(["U5 workerd-decodes-header-bytes-as-utf8"])
    expect(judge(echoed, outcomes, new Set(["U5"])).violations[0]?.kind).toBe("difference")
  })
})

test("known stderr entries are matched as whole entries, with what follows them", () => {
  const log =
    "\x1b[31m✘ [ERROR] Failed to drain the unused request body. Error: Network connection lost.\x1b[0m\n    at drainBody (x.ts:1)\n  }\nsomething new\n"
  expect(unknownStderr("workerd", log)).toEqual({
    rest: "something new",
    known: ["U8 wrangler-proxy-log"],
  })
  expect(unknownStderr("node", log).rest).toContain("Failed to drain")
})

test("a seed generates the same cases, each with the reasons a parser may refuse it", () => {
  const first = fc.sample(caseArbitrary, { seed: 7, numRuns: 50 })
  expect(fc.sample(caseArbitrary, { seed: 7, numRuns: 50 })).toEqual(first)
  for (const generated of first) {
    expect(generated.request.headers.filter(([name]) => name === "Connection")).toEqual([])
    if (/[^\x21-\x7e]/.test(generated.request.target))
      expect(generated.refusable).toContain("target bytes")
  }
})

test("a printed case replays as the same case, and anything else is refused", () => {
  for (const generated of fc.sample(caseArbitrary, { seed: 11, numRuns: 50 }))
    expect(parseCase(JSON.stringify(generated))).toEqual(generated)
  expect(() => parseCase('{"route":"nowhere","request":{},"refusable":[]}')).toThrow(
    "unknown route",
  )
  expect(() =>
    parseCase(JSON.stringify({ ...caseOf(get("/")), request: { ...get("/"), framing: {} } })),
  ).toThrow("not a framing")
})
