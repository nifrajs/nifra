import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import fc from "fast-check"
import { createDifferentialApp, INTERNAL_SENTINEL } from "./fixtures/runtime-differential/app.ts"
import {
  type Case,
  caseArbitrary,
  parseCase,
  parseWsCase,
  wsCaseArbitrary,
} from "./runtime-differential/arbitraries.ts"
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
import {
  runWsCase,
  type WsCase,
  type WsEvent,
  type WsOutcome,
  type WsStep,
} from "./runtime-differential/ws.ts"
import { judgeWs } from "./runtime-differential/ws-oracle.ts"

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

  test("form pages that differ only in what the action read wait on W2, and nothing else does", () => {
    const page = (saved: string, heading = "form") =>
      response(200, `<h1>${heading}</h1><p class="saved">${saved}</p>`, [
        ["content-type", "text/html; charset=utf-8"],
      ])
    const form = caseOf({ ...get("/pages/form"), method: "POST" }, "pageForm")
    const read = new Map<LaneName, Outcome>([
      ["bun-serve", page("[[&quot;f&quot;,{&quot;type&quot;:&quot;text/plain&quot;}]]")],
      ["deno", page("[[&quot;f&quot;,{&quot;type&quot;:&quot;&quot;}]]")],
      ["workerd", response(400, '{"error":"invalid_form"}')],
    ])
    expect(judge(form, read)).toEqual({
      violations: [],
      excusedBy: ["W2 runtime-form-parsers-differ"],
    })
    const elsewhere = new Map<LaneName, Outcome>([...read, ["deno", page("[]", "other")]])
    expect(judge(form, elsewhere).violations[0]?.kind).toBe("difference")
    const otherRoute = caseOf(get("/pages"), "pageHome")
    expect(judge(otherRoute, read).violations[0]?.kind).toBe("difference")
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

describe("judgeWs", () => {
  const wsCase = (steps: WsStep[], route: WsCase["route"] = "echo"): WsCase => ({
    kind: "ws",
    route,
    path: route === "guarded" ? "/ws/guarded" : "/ws/echo",
    headers: route === "guarded" ? [["x-ws-token", "throw"]] : [],
    steps,
    peers: 0,
  })
  const opened = (upgrade = "websocket"): WsEvent => ({
    kind: "open",
    headers: [
      ["upgrade", upgrade],
      ["connection", "Upgrade"],
      ["sec-websocket-accept", "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="],
      ["date", "Mon"],
    ],
  })
  const said = (value: string): WsEvent => ({ kind: "text", bytes: bytes(value) })
  const closed = (code: number, reason = ""): WsEvent => ({
    kind: "close",
    bytes: Uint8Array.of(code >> 8, code & 0xff, ...bytes(reason)),
  })
  const lanes = (...sessions: [LaneName, WsEvent[]][]) =>
    new Map<LaneName, WsOutcome>(sessions.map(([lane, events]) => [lane, { sockets: [events] }]))
  const hi = wsCase([{ kind: "text", text: "hi" }])

  test("agreeing sessions pass; the handshake tokens compare without case", () => {
    const outcomes = lanes(
      ["bun-serve", [opened(), said("hi"), closed(1000)]],
      ["node", [opened("WebSocket"), said("hi"), closed(1000)]],
    )
    expect(judgeWs(hi, outcomes)).toEqual({ violations: [], excusedBy: [] })
  })

  test("a different frame is a difference, and the sentinel in a frame a leak", () => {
    const differing = lanes(
      ["bun-serve", [opened(), said("hi"), closed(1000)]],
      ["deno", [opened(), said("hi"), closed(1000, "bye")]],
    )
    expect(judgeWs(hi, differing).violations.map((violation) => violation.kind)).toEqual([
      "difference",
    ])
    const leaked = lanes(["node", [opened(), said(`boom ${INTERNAL_SENTINEL}`)]])
    expect(judgeWs(hi, leaked).violations.map((violation) => violation.signature)).toEqual([
      "leak ws:echo sentinel [node]",
    ])
  })

  test("a refused handshake is a server error unless the guard throws by design", () => {
    const refused: WsEvent = { kind: "refused", status: 500, headers: [], body: bytes("{}") }
    expect(judgeWs(wsCase([], "guarded"), lanes(["node", [refused]])).violations).toEqual([])
    expect(judgeWs(hi, lanes(["node", [refused]])).violations[0]?.signature).toBe(
      "server-error ws:echo 500 [node]",
    )
  })

  test("Bun's 1000 for a close without a code waits on WS1, and only that", () => {
    const noCode = wsCase([{ kind: "text", text: "close::" }])
    const empty: WsEvent = { kind: "close", bytes: new Uint8Array(0) }
    const outcomes = lanes(["bun-serve", [opened(), closed(1000)]], ["node", [opened(), empty]])
    expect(judgeWs(noCode, outcomes)).toEqual({
      violations: [],
      excusedBy: ["WS1 bun-close-without-code-sends-1000"],
    })
    expect(judgeWs(hi, outcomes).violations[0]?.kind).toBe("difference")
    const alsoText = lanes(
      ["bun-serve", [opened(), said("x"), closed(1000)]],
      ["node", [opened(), empty]],
    )
    expect(judgeWs(noCode, alsoText).violations[0]?.kind).toBe("difference")
  })

  test("after a forbidden frame or a message over the cap, each runtime closes its own way", () => {
    const failed = wsCase([{ kind: "unmasked" }])
    const forbidden: WsEvent = { kind: "violation", step: "unmasked" }
    expect(
      judgeWs(
        failed,
        lanes(
          ["node", [opened(), forbidden, closed(1002)]],
          ["deno", [opened(), forbidden, said("x")]],
        ),
      ).violations,
    ).toEqual([])
    const big = wsCase([{ kind: "binary", size: 5000 }])
    const over: WsEvent = { kind: "oversize" }
    expect(
      judgeWs(
        big,
        lanes(
          ["bun-serve", [opened(), over, { kind: "end" }]],
          ["node", [opened(), over, closed(1009)]],
        ),
      ).violations,
    ).toEqual([])
  })
})

test("a session goes over a real socket, and the watcher hears the server's close", async () => {
  const running = createDifferentialApp().listen(0, { hostname: "127.0.0.1" })
  try {
    const outcome = await runWsCase(
      running.port,
      wsCase([
        { kind: "fragments", parts: ["a", "b"] },
        { kind: "binary", size: 3 },
        { kind: "text", text: "close:999:" },
        { kind: "text", text: "close:4000:bye" },
      ]),
      5000,
    )
    const shown = outcome.sockets.map((events) => events.map(eventText))
    expect(shown).toEqual([
      ["open", "text ab", "binary 0,1,2", "text refused:range", "close 4000 bye"],
      ["open", "text joined", "text closed:4000:bye", "close 1000 done"],
    ])
  } finally {
    running.stop(true)
  }

  function wsCase(steps: WsStep[]): WsCase {
    return { kind: "ws", route: "echo", path: "/ws/echo", headers: [], steps, peers: 0 }
  }
  function eventText(event: WsEvent): string {
    if (event.kind === "text") return `text ${new TextDecoder().decode(event.bytes)}`
    if (event.kind === "binary") return `binary ${event.bytes.join(",")}`
    if (event.kind === "close") {
      const reason = new TextDecoder().decode(event.bytes.subarray(2))
      return `close ${((event.bytes[0] ?? 0) << 8) | (event.bytes[1] ?? 0)} ${reason}`
    }
    return event.kind
  }
})

test("a seeded WebSocket case replays as the same case, and anything else is refused", () => {
  const sampled = fc.sample(wsCaseArbitrary, { seed: 3, numRuns: 50 })
  expect(fc.sample(wsCaseArbitrary, { seed: 3, numRuns: 50 })).toEqual(sampled)
  for (const generated of sampled) expect(parseWsCase(JSON.stringify(generated))).toEqual(generated)
  expect(() => parseWsCase('{"kind":"ws","route":"nowhere"}')).toThrow()
})
