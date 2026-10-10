/**
 * Every layer that stores a response and answers a later request with it (a response cache, an
 * idempotency replay, ISR, CDN cache headers) must keep one caller's answer from reaching another.
 * Each layer runs the same scenarios against the same origin; a scenario a layer does not take part
 * in names the reason. The registry at the end fails when a source file starts using a storing
 * primitive without being enrolled here or listed as not a layer.
 */
import { describe, expect, test } from "bun:test"
import { type AnyServer, authenticated, rejected, server } from "@nifrajs/core"
import { idempotency as coreIdempotency } from "@nifrajs/core/idempotency-plugin"
import {
  cache,
  idempotency,
  MemoryIdempotencyStore,
  MemoryResponseCache,
} from "@nifrajs/middleware"
import { MemoryCacheStore, withISR } from "@nifrajs/web"
import { defineCdnProvider, withCdn } from "@nifrajs/web/cdn"

const SERVICE_KEY = "s".repeat(40)

/** What the origin answers; `secret` marks a body rendered for a credentialed request. */
interface Shape {
  readonly status?: (call: number) => number
  readonly headers?: (call: number) => Record<string, string>
}

function origin(shape: Shape = {}) {
  let calls = 0
  const handle = (req: Request): Response => {
    calls += 1
    const credentialed = ["authorization", "cookie", "x-service-key"].some((name) =>
      req.headers.has(name),
    )
    return new Response(`<p>${credentialed ? "secret" : "public"}#${calls}</p>`, {
      status: shape.status?.(calls) ?? 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-nifra-isr-revalidate": "60",
        ...shape.headers?.(calls),
      },
    })
  }
  return { handle, calls: () => calls }
}

type Send = (headers?: Record<string, string>) => Promise<Response>

/** A route behind an authentication stage that accepts only `x-service-key`. */
function withStage(app: AnyServer, stage: boolean): AnyServer {
  if (!stage) return app
  return app.authenticate({
    id: "service-key",
    run: (input) =>
      input.headers.get("x-service-key") === SERVICE_KEY ? authenticated("service") : rejected(),
  })
}

interface Layer {
  readonly name: string
  /** The source file that decides what this layer stores. */
  readonly file: string
  build(handle: (req: Request) => Response, stage: boolean): Send
  /** Scenarios this layer does not take part in, each with the reason. */
  readonly exempt?: Readonly<Partial<Record<ScenarioId, string>>>
}

const page = (send: (req: Request) => Response | Promise<Response>): Send => {
  return async (headers = {}) => send(new Request("http://x/r", { headers }))
}

const idempotent = (app: AnyServer): Send => {
  return async (headers = {}) =>
    app.fetch(
      new Request("http://x/r", {
        method: "POST",
        headers: { "idempotency-key": "order-1", ...headers },
      }),
    )
}

const IDEMPOTENT_REPLAY =
  "a replay answers a retry of the same operation in the same scope; cache-control governs shared caches"

const LAYERS: readonly Layer[] = [
  {
    name: "middleware cache()",
    file: "packages/middleware/src/cache.ts",
    build: (handle, stage) => {
      const app = withStage(
        server().use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000 })),
        stage,
      ).get("/r", (c) => handle(c.req))
      return page((req) => app.fetch(req))
    },
  },
  {
    name: "middleware idempotency()",
    file: "packages/middleware/src/idempotency.ts",
    build: (handle, stage) =>
      idempotent(
        withStage(server().use(idempotency({ store: new MemoryIdempotencyStore() })), stage).post(
          "/r",
          (c) => handle(c.req),
        ),
      ),
    exempt: { private: IDEMPOTENT_REPLAY },
  },
  {
    name: "core idempotency lane",
    file: "packages/core/src/server/idempotency-lane.ts",
    build: (handle, stage) =>
      idempotent(
        withStage(server().use(coreIdempotency()), stage).post(
          "/r",
          {
            idempotency: {
              scope: "request",
              namespace: stage
                ? (req) => `key-${req.headers.get("x-service-key") ?? "none"}`
                : "shared",
            },
          },
          (c) => handle(c.req),
        ),
      ),
    exempt: {
      private: IDEMPOTENT_REPLAY,
      authorization:
        "a credential counts only through an authentication stage, whose routes must resolve a principal namespace",
      cookie:
        "a credential counts only through an authentication stage, whose routes must resolve a principal namespace",
      "read-side":
        "an anonymous request never reaches a stage-protected route, so nothing is stored for it",
    },
  },
  {
    name: "withISR",
    file: "packages/web/src/isr.ts",
    build: (handle, stage) => {
      const app = withStage(server(), stage).get("/r", (c) => handle(c.req))
      return page(withISR(app, { store: new MemoryCacheStore(), revalidate: 60, now: () => 0 }))
    },
  },
  {
    name: "withCdn (behind a URL-keyed shared cache)",
    file: "packages/web/src/cdn.ts",
    build: (handle, stage) => {
      const app = withStage(server(), stage).get("/r", (c) => handle(c.req))
      const provider = defineCdnProvider(
        {
          name: "invariants",
          tagsPerCall: 100,
          maxResponseTags: 16,
          cacheHeaders: () => ({ "x-cdn": "store" }),
          noStoreHeaders: () => ({ "x-cdn": "no-store" }),
          purgeTags: async () => ({ ok: true }),
        },
        { debounceMs: 0, sleep: async () => {}, onError: () => {} },
      )
      const handler = withCdn(app, { provider })
      let stored: Response | undefined
      return page(async (req) => {
        if (stored !== undefined) return stored.clone()
        const res = await handler(req)
        if (res.headers.get("x-cdn") === "store") stored = res.clone()
        return res
      })
    },
    exempt: {
      "read-side": "the CDN's own lookup decides what a credentialed request is served",
    },
  },
]

const SCENARIOS = [
  {
    id: "authorization",
    title: "a response to an Authorization request never reaches an anonymous one",
    run: async (layer: Layer) => {
      const o = origin()
      const send = layer.build(o.handle, false)
      expect(await (await send({ authorization: "Bearer owner" })).text()).toContain("secret")
      expect(await (await send()).text()).not.toContain("secret")
    },
  },
  {
    id: "cookie",
    title: "a response to a cookie request never reaches an anonymous one",
    run: async (layer: Layer) => {
      const o = origin()
      const send = layer.build(o.handle, false)
      expect(await (await send({ cookie: "sid=owner" })).text()).toContain("secret")
      expect(await (await send()).text()).not.toContain("secret")
    },
  },
  {
    id: "auth-stage",
    title:
      "a response to a request an authentication stage accepted never reaches an anonymous one",
    run: async (layer: Layer) => {
      const o = origin()
      const send = layer.build(o.handle, true)
      expect(await (await send({ "x-service-key": SERVICE_KEY })).text()).toContain("secret")
      const anonymous = await send()
      expect(anonymous.status).toBe(401)
      expect(await anonymous.text()).not.toContain("secret")
    },
  },
  {
    id: "read-side",
    title: "a stored anonymous response is not served to a credentialed request",
    run: async (layer: Layer) => {
      const o = origin()
      const send = layer.build(o.handle, false)
      await send()
      expect(await (await send({ authorization: "Bearer owner" })).text()).toContain("secret")
    },
  },
  {
    id: "set-cookie",
    title: "a Set-Cookie is never handed to a second request",
    run: async (layer: Layer) => {
      const o = origin({ headers: (call) => ({ "set-cookie": `session=${call}; HttpOnly` }) })
      const send = layer.build(o.handle, false)
      expect((await send()).headers.get("set-cookie")).toBe("session=1; HttpOnly")
      expect((await send()).headers.get("set-cookie")).not.toBe("session=1; HttpOnly")
    },
  },
  {
    id: "private",
    title: "a private or no-store response is rendered afresh for the next request",
    run: async (layer: Layer) => {
      for (const directive of ["private", "no-store"]) {
        const o = origin({ headers: () => ({ "cache-control": directive }) })
        const send = layer.build(o.handle, false)
        await send()
        expect({ directive, body: await (await send()).text() }).toEqual({
          directive,
          body: "<p>public#2</p>",
        })
      }
    },
  },
  {
    id: "refusal",
    title: "a refusal is never stored as the answer",
    run: async (layer: Layer) => {
      for (const status of [401, 403]) {
        const o = origin({ status: (call) => (call === 1 ? status : 200) })
        const send = layer.build(o.handle, false)
        expect((await send()).status).toBe(status)
        const next = await send()
        expect({ status, next: next.status, calls: o.calls() }).toEqual({
          status,
          next: 200,
          calls: 2,
        })
      }
    },
  },
] as const

type ScenarioId = (typeof SCENARIOS)[number]["id"]

for (const layer of LAYERS) {
  describe(layer.name, () => {
    for (const scenario of SCENARIOS) {
      const reason = layer.exempt?.[scenario.id]
      if (reason !== undefined) test.skip(`${scenario.title} - not a member: ${reason}`, () => {})
      else test(scenario.title, () => scenario.run(layer))
    }
  })
}

// Source files that use a storing primitive but decide nothing about what is stored or replayed.
const NOT_LAYERS: Readonly<Record<string, string>> = {
  "packages/core/src/idempotency.ts": "stores and the serialized record; the lane decides",
  "packages/core/src/index.ts": "re-exports",
  "packages/core/src/server.ts": "re-exports",
  "packages/core/src/server/auth.ts": "defines the authenticated-request mark the layers read",
  "packages/middleware/src/index.ts": "re-exports",
  "packages/web/src/index.ts": "re-exports",
  "packages/web/src/draft.ts": "draft mode tells withISR to bypass; it stores nothing",
  "packages/web/src/internal/render-document.ts": "renders the page withISR stores",
  "packages/web/src/internal/web-app.ts": "opens the ISR header channel; withISR stores",
  "packages/web/src/manifest.ts": "route metadata",
  "packages/web/src/route-manifest.ts": "route metadata",
  "packages/cli/src/cdn-check.ts": "a static check, not a runtime layer",
  "packages/cli/src/recipes/4.0.0.ts": "an upgrade codemod",
  "packages/core/src/server/context.ts": "route option types",
  "packages/core/src/tool-contract.ts":
    "tool idempotency refuses a duplicate call; it replays no result",
  "packages/agent/src/index.ts": "passes a tool idempotency store through",
}

test("every source file that uses a storing primitive is enrolled or named as not a layer", async () => {
  const root = new URL("../../../", import.meta.url).pathname
  const glob = new Bun.Glob("packages/*/src/**/*.{ts,tsx}")
  const users: string[] = []
  for await (const file of glob.scan({ cwd: root })) {
    const source = await Bun.file(`${root}${file}`).text()
    if (
      /isCacheablePage|isAuthenticatedRequest|serializeResponse\(|ResponseCacheStore|IdempotencyStore\b|withISR/.test(
        source,
      )
    )
      users.push(file)
  }
  const enrolled = new Set(LAYERS.map((layer) => layer.file))
  const unknown = users.filter((file) => !enrolled.has(file) && NOT_LAYERS[file] === undefined)
  const stale = Object.keys(NOT_LAYERS).filter((file) => !users.includes(file))
  expect({ unknown: unknown.sort(), stale }).toEqual({ unknown: [], stale: [] })
})
