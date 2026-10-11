import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { executeCapability } from "../src/capabilities.ts"
import { effectLedger } from "../src/effect-ledger.ts"
import { idempotency } from "../src/idempotency-plugin.ts"
import { authenticated, rejected, server } from "../src/index.ts"
import { createMemoryLedgerSink } from "../src/ledger.ts"

const request = (key = "key-a") =>
  new Request("http://test/protected", {
    method: "POST",
    headers: {
      authorization: "Bearer synthetic-identity",
      "idempotency-key": key,
      "content-type": "application/json",
    },
    body: '{"amount":1}',
  })

describe("idempotent replay prerequisites", () => {
  for (const mode of ["sync", "async"] as const) {
    for (const validationOrder of ["auth-before-validation", "validate-before-auth"] as const) {
      test(`${mode} authentication rechecks current permission and session (${validationOrder})`, async () => {
        let sessionActive = true
        let allowed = true
        let authRuns = 0
        let effects = 0
        const authorize = () => {
          authRuns++
          return !sessionActive
            ? rejected()
            : allowed
              ? authenticated({ id: "synthetic" })
              : rejected("forbidden")
        }
        const app = server()
          .use(idempotency())
          .authenticate({
            id: "current-permission",
            mode,
            run: () => (mode === "async" ? Promise.resolve(authorize()) : authorize()),
          })
          .post(
            "/protected",
            {
              body: t.object({ amount: t.number() }),
              validationOrder,
              idempotency: {
                scope: "request",
                namespace: (input) => {
                  // Identity is stable and valid independently of the current route permission.
                  expect(input.headers.get("authorization")).toBe("Bearer synthetic-identity")
                  return "principal:synthetic"
                },
              },
            },
            (ctx) => {
              effects++
              ctx.set.status = 201
              ctx.set.headers["x-created"] = "1"
              return { effect: effects, amount: ctx.body.amount }
            },
          )

        const first = await app.fetch(request())
        const replay = await app.fetch(request())
        expect(first.status).toBe(201)
        expect(replay.status).toBe(201)
        expect(replay.headers.get("x-created")).toBe("1")
        expect(replay.headers.get("x-nifra-idempotent-replay")).toBe("1")
        expect(await replay.json()).toEqual(await first.json())
        allowed = false
        const forbiddenReplay = await app.fetch(request())
        const forbiddenFresh = await app.fetch(request("key-b"))
        expect(forbiddenReplay.status).toBe(403)
        expect(forbiddenFresh.status).toBe(403)
        expect(forbiddenReplay.headers.has("x-nifra-idempotent-replay")).toBe(false)
        allowed = true
        sessionActive = false
        expect((await app.fetch(request())).status).toBe(401)
        sessionActive = true
        const restored = await app.fetch(request())
        expect(restored.status).toBe(201)
        expect(restored.headers.get("x-nifra-idempotent-replay")).toBe("1")
        expect(authRuns).toBe(6)
        expect(effects).toBe(1)
      })
    }
  }

  test("derive/before/around policy runs on replay without applying stored transformations again", async () => {
    let allowed = true
    let suspended = false
    let failPolicy = false
    let derives = 0
    let checks = 0
    let arounds = 0
    let handlers = 0
    let transformations = 0
    const app = server()
      .use(idempotency())
      .around((_ctx, next) => {
        arounds++
        return suspended ? new Response(null, { status: 401 }) : next()
      })
      .derive(() => {
        derives++
        return { permitted: allowed }
      })
      .beforeHandle((ctx) => {
        checks++
        if (failPolicy) throw new Error("synthetic policy unavailable")
        if (!ctx.permitted) return new Response(null, { status: 403 })
        return undefined
      })
      .afterHandle((value) => ({ wrapped: value, transform: ++transformations }))
      .onError(() => new Response(null, { status: 503 }))
      .post(
        "/protected",
        { idempotency: { scope: "request", namespace: "public:policy" } },
        () => ({ execution: ++handlers }),
      )

    const first = await app.fetch(request())
    const replay = await app.fetch(request())
    expect(await replay.json()).toEqual(await first.json())
    expect(transformations).toBe(1)
    allowed = false
    expect((await app.fetch(request())).status).toBe(403)
    allowed = true
    suspended = true
    expect((await app.fetch(request())).status).toBe(401)
    suspended = false
    failPolicy = true
    expect((await app.fetch(request())).status).toBe(503)
    failPolicy = false
    expect((await app.fetch(request())).headers.get("x-nifra-idempotent-replay")).toBe("1")
    expect(handlers).toBe(1)
    expect(transformations).toBe(1)
    expect(arounds).toBe(6)
    expect(derives).toBe(5)
    expect(checks).toBe(5)
  })

  test("pending replay authentication respects the request deadline", async () => {
    let stall = false
    let signal: AbortSignal | undefined
    let executions = 0
    const app = server({ requestTimeoutMs: 10 })
      .use(idempotency())
      .authenticate({
        id: "deadline-auth",
        mode: "async",
        async run(input) {
          signal = input.signal
          if (stall)
            await new Promise<void>((resolve) =>
              input.signal.addEventListener("abort", () => resolve(), { once: true }),
            )
          return authenticated({ id: "synthetic" })
        },
      })
      .post(
        "/protected",
        { idempotency: { scope: "request", namespace: () => "principal:synthetic" } },
        () => ({ execution: ++executions }),
      )
    expect((await app.fetch(request())).status).toBe(200)
    stall = true
    const replay = await app.fetch(request())
    expect(replay.status).toBe(503)
    expect(signal?.aborted).toBe(true)
    expect(replay.headers.has("x-nifra-idempotent-replay")).toBe(false)
    expect(executions).toBe(1)
  })

  test("an admitted replay neither executes the owned effect nor creates another effect ledger", async () => {
    const memory = createMemoryLedgerSink()
    let effects = 0
    let authRuns = 0
    const app = server()
      .use(idempotency())
      .use(effectLedger({ sink: memory.sink }))
      .authenticate({
        id: "ledger-auth",
        mode: "sync",
        run() {
          authRuns++
          return authenticated({ id: "synthetic" })
        },
      })
      .post(
        "/protected",
        {
          capabilities: ["db.write"],
          idempotency: { scope: "request", namespace: () => "principal:synthetic" },
        },
        (ctx) =>
          executeCapability(ctx, "db.write", { target: "synthetic:counter" }, async () => ({
            effect: ++effects,
          })),
      )
    const first = await app.fetch(request())
    const replay = await app.fetch(request())
    expect(await replay.json()).toEqual(await first.json())
    expect(replay.headers.get("x-nifra-idempotent-replay")).toBe("1")
    expect(authRuns).toBe(2)
    expect(effects).toBe(1)
    expect(memory.ledgers).toHaveLength(1)
    expect(memory.ledgers[0]?.entries.map((entry) => entry.phase)).toEqual(["intent", "committed"])
  })
})
