import { afterEach, describe, expect, test } from "bun:test"
import {
  type AnyServer,
  authenticated,
  type RunningServer,
  rejected,
  server,
} from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import { websocket } from "../src/ws.ts"

/**
 * An `authenticate()` stage reads the query a handler's `c.query` parses, from the same string,
 * on every lane, as frozen values it cannot pass on to the route's own validation.
 */

const CORPUS = [
  "",
  "?",
  "?a=1&b=2",
  "?a=%20x%2Fy",
  "?a=b+c",
  "?a=",
  "?a&b",
  "?t=a&t=b&t=c",
  "?__proto__=x&constructor=y",
  "?x=1&x=",
  "?%E2%9C%93=%E2%9C%93",
  "?a=%ZZ",
  "?a=1#fragment",
  `?long=${"z".repeat(4_096)}`,
]

let running: RunningServer | undefined
afterEach(() => {
  running?.stop(true)
  running = undefined
})

type Lane = (app: AnyServer, path: string) => Promise<number>

const LANES: ReadonlyArray<readonly [string, Lane]> = [
  ["app.fetch", async (app, path) => (await app.fetch(new Request(`http://x${path}`))).status],
  [
    "node",
    async (app, path) => {
      const outcome = await app.resolveNode(new Request(`http://x${path}`))
      return outcome.kind === "response" ? outcome.response.status : outcome.status
    },
  ],
  [
    "bun listen",
    async (app, path) => {
      running ??= app.listen(0, { hostname: "127.0.0.1" })
      const response = await fetch(`http://127.0.0.1:${running.port}${path}`)
      await response.arrayBuffer()
      return response.status
    },
  ],
]

const deepFrozen = (query: Readonly<Record<string, string | readonly string[]>>): boolean =>
  Object.isFrozen(query) &&
  Object.values(query).every((value) => typeof value === "string" || Object.isFrozen(value))

describe("the authentication stage's query", () => {
  test("is the query the route validates, from the same search, frozen, on every lane", async () => {
    const searches: Record<string, string[]> = {}
    for (const [lane, send] of LANES) {
      const seen: Array<{ search: string; query: unknown; frozen: boolean }> = []
      const validated: unknown[] = []
      const app = server()
        .use(nodeDirect())
        .authenticate({
          id: "query-probe",
          mode: "sync",
          run(input) {
            seen.push({
              search: input.search,
              query: input.query,
              frozen: deepFrozen(input.query),
            })
            return authenticated({ id: "u1" })
          },
        })
        .get(
          "/q",
          {
            query: {
              "~standard": {
                version: 1,
                vendor: "query-probe",
                validate(value: unknown) {
                  validated.push(value)
                  return { value }
                },
              },
            },
          },
          () => ({ ok: true }),
        )
      for (const search of CORPUS) {
        expect([lane, search, await send(app, `/q${search}`)]).toEqual([lane, search, 200])
      }
      expect(seen.map((entry) => entry.query)).toEqual(validated)
      expect(seen.every((entry) => entry.frozen)).toBe(true)
      searches[lane] = seen.map((entry) => entry.search)
      running?.stop(true)
      running = undefined
    }
    expect(searches.node).toEqual(searches["app.fetch"])
    expect(searches["bun listen"]).toEqual(searches["app.fetch"])
  })

  test("a WebSocket ticket in the query authenticates the upgrade; a repeated one is no ticket", async () => {
    const app = server()
      .use(websocket())
      .authenticate({
        id: "ticket",
        mode: "sync",
        run: (input) =>
          input.query.ticket === "t1" ? authenticated({ id: "u1" }) : rejected("unauthenticated"),
      })
      .ws("/socket", { upgrade: (c) => ({ user: c.principal.id }) })
    const upgrade = async (path: string) => {
      const resolve = app.resolveWebSocketUpgrade
      if (resolve === undefined) throw new Error("the server takes no upgrades")
      const outcome = await resolve.call(
        app,
        new Request(`http://x${path}`, { headers: { upgrade: "websocket" } }),
      )
      return outcome.kind === "reject" ? outcome.response.status : outcome.kind
    }
    expect(await upgrade("/socket?ticket=t1")).toBe("upgrade")
    expect(await upgrade("/socket?ticket=t1&ticket=t1")).toBe(401)
    expect(await upgrade("/socket")).toBe(401)
  })
})
