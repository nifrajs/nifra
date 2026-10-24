import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { server } from "@nifrajs/core"
import type { LogFields, Logger } from "@nifrajs/core/server"
import { healthcheck } from "@nifrajs/middleware"

const LIFECYCLE = Symbol.for("@nifrajs/core/server-lifecycle")

/** Begin a stop's first phase the way an adapter does, without a listener. */
async function beginStopping(app: object): Promise<void> {
  const run: unknown = Reflect.get(app, LIFECYCLE)
  if (typeof run !== "function") throw new Error("no server lifecycle")
  await Reflect.apply(run, app, ["stopping"])
}

function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

function capture(): {
  readonly logger: Logger
  readonly lines: [string, string, LogFields | undefined][]
} {
  const lines: [string, string, LogFields | undefined][] = []
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push([level, message, fields])
    }
  return {
    lines,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
  }
}

const ready = (app: { fetch(req: Request): Response | Promise<Response> }) =>
  Promise.resolve(app.fetch(new Request("http://x/ready")))

afterEach(() => {
  setSystemTime()
})

describe("healthcheck()", () => {
  test("/health is a flat 200 with no-store", async () => {
    const app = server().use(healthcheck())
    const res = await app.fetch(new Request("http://x/health"))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ status: "ok" })
  })

  test("/ready is 200 with no checks", async () => {
    const app = server().use(healthcheck())
    const res = await ready(app)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ status: "ok", checks: {} })
  })

  test("/ready reports each check with its duration and is 200 when all pass", async () => {
    const app = server().use(
      healthcheck({ checks: { db: () => true, cache: async () => true }, logger: false }),
    )
    const res = await ready(app)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: "ok",
      checks: {
        db: { status: "pass", ms: expect.any(Number) },
        cache: { status: "pass", ms: expect.any(Number) },
      },
    })
  })

  test("/ready is 503 when a check fails or throws", async () => {
    const app = server().use(
      healthcheck({
        checks: {
          ok: () => true,
          down: () => false,
          boom: () => {
            throw new Error("unreachable")
          },
        },
        logger: false,
      }),
    )
    const res = await ready(app)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      status: "error",
      checks: {
        ok: { status: "pass", ms: expect.any(Number) },
        down: { status: "fail", ms: expect.any(Number) },
        boom: { status: "fail", ms: expect.any(Number) },
      },
    })
  })

  test("a check past its timeout reports timeout and its signal aborts", async () => {
    let seen: AbortSignal | undefined
    const app = server().use(
      healthcheck({
        checks: {
          hung: {
            check: (signal) => {
              seen = signal
              return new Promise<boolean>(() => {})
            },
            timeoutMs: 5,
          },
          quick: () => true,
        },
        timeoutMs: 60_000,
        logger: false,
      }),
    )
    const res = await ready(app)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      status: "error",
      checks: { hung: { status: "timeout" }, quick: { status: "pass" } },
    })
    expect(seen?.aborted).toBe(true)
    expect(seen?.reason).toBeInstanceOf(DOMException)
    expect(Reflect.get(seen?.reason ?? {}, "name")).toBe("TimeoutError")
  })

  test("the healthcheck's timeoutMs applies to a check that sets none", async () => {
    const app = server().use(
      healthcheck({
        checks: { hung: () => new Promise<boolean>(() => {}) },
        timeoutMs: 5,
        logger: false,
      }),
    )
    expect(await (await ready(app)).json()).toMatchObject({
      checks: { hung: { status: "timeout" } },
    })
  })

  test("a failing optional check reports degraded and keeps 200", async () => {
    const app = server().use(
      healthcheck({
        checks: { db: () => true, bus: { check: () => false, optional: true } },
        logger: false,
      }),
    )
    const res = await ready(app)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: "degraded",
      checks: {
        db: { status: "pass", ms: expect.any(Number) },
        bus: { status: "fail", ms: expect.any(Number), optional: true },
      },
    })
  })

  test("a failing required check wins over a degraded one", async () => {
    const app = server().use(
      healthcheck({
        checks: { bus: { check: () => false, optional: true }, db: () => false },
        logger: false,
      }),
    )
    const res = await ready(app)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: "error" })
  })

  test("probes arriving while the checks run share one run", async () => {
    const held = gate()
    let calls = 0
    const app = server().use(
      healthcheck({
        checks: {
          db: async () => {
            calls += 1
            await held.wait
            return true
          },
        },
        cacheMs: 0,
      }),
    )
    const first = ready(app)
    const second = ready(app)
    held.open()
    const [a, b] = await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(await a.json()).toEqual(await b.json())
  })

  test("a check still running from a timed-out probe is waited on, not called again", async () => {
    let calls = 0
    const app = server().use(
      healthcheck({
        checks: {
          // Ignores its abort signal, as a client without cancellation would.
          stuck: () => {
            calls += 1
            return new Promise<boolean>(() => {})
          },
        },
        timeoutMs: 5,
        cacheMs: 0,
        logger: false,
      }),
    )
    await ready(app)
    const res = await ready(app)
    expect(await res.json()).toMatchObject({ checks: { stuck: { status: "timeout" } } })
    expect(calls).toBe(1)
  })

  test("a finished run answers probes for cacheMs, then the checks run again", async () => {
    setSystemTime(new Date("2030-01-01T00:00:00.000Z"))
    let calls = 0
    const app = server().use(
      healthcheck({
        checks: {
          db: () => {
            calls += 1
            return true
          },
        },
        cacheMs: 1_000,
      }),
    )
    await ready(app)
    await ready(app)
    expect(calls).toBe(1)
    setSystemTime(new Date("2030-01-01T00:00:00.999Z"))
    await ready(app)
    expect(calls).toBe(1)
    setSystemTime(new Date("2030-01-01T00:00:01.000Z"))
    await ready(app)
    expect(calls).toBe(2)
  })

  test("/ready answers 503 stopping once a stop begins, without running a check", async () => {
    let calls = 0
    const app = server().use(
      healthcheck({
        checks: {
          db: () => {
            calls += 1
            return true
          },
        },
      }),
    )
    await beginStopping(app)
    const res = await ready(app)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: "stopping", checks: {} })
    expect(calls).toBe(0)
    expect((await app.fetch(new Request("http://x/health"))).status).toBe(200)
  })

  test("a stop that begins while the checks run wins over what they found", async () => {
    const held = gate()
    const app = server().use(
      healthcheck({
        checks: {
          db: async () => {
            await held.wait
            return true
          },
        },
      }),
    )
    const probe = ready(app)
    await beginStopping(app)
    held.open()
    const res = await probe
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: "stopping", checks: {} })
  })

  test("a listening server's /ready fails as stop() begins, before the drain", async () => {
    const held = gate()
    let entered!: () => void
    const stopping = new Promise<void>((resolve) => {
      entered = resolve
    })
    const app = server()
      .use(healthcheck({ checks: { db: () => true } }))
      .onStopping(async () => {
        entered()
        await held.wait
      })
    const srv = app.listen(0, { hostname: "127.0.0.1" })
    const base = `http://127.0.0.1:${srv.port}`
    expect((await fetch(`${base}/ready`)).status).toBe(200)
    const stopped = app.stop()
    await stopping
    const res = await fetch(`${base}/ready`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: "stopping", checks: {} })
    expect((await fetch(`${base}/health`)).status).toBe(200)
    held.open()
    await stopped
  })

  test("one instance on two servers reports each server's own stop", async () => {
    const plugin = healthcheck()
    const stopped = server().use(plugin)
    const running = server().use(plugin)
    await beginStopping(stopped)
    expect((await ready(stopped)).status).toBe(503)
    expect((await ready(running)).status).toBe(200)
  })

  test("logs a check that starts failing, and again when it passes", async () => {
    const { logger, lines } = capture()
    const results = [true, false, false, true, true]
    const app = server().use(
      healthcheck({
        checks: {
          db: () => {
            const next = results.shift()
            if (next === false) throw new Error("connection refused")
            return true
          },
        },
        cacheMs: 0,
        logger,
      }),
    )
    for (let i = 0; i < 5; i++) await ready(app)
    expect(lines).toEqual([
      [
        "warn",
        "readiness check failing",
        {
          check: "db",
          status: "fail",
          ms: expect.any(Number),
          optional: false,
          error: "connection refused",
        },
      ],
      ["info", "readiness check passing", { check: "db", ms: expect.any(Number) }],
    ])
  })

  test("a check failing on its first run is logged", async () => {
    const { logger, lines } = capture()
    const app = server().use(healthcheck({ checks: { db: () => false }, logger }))
    await ready(app)
    expect(lines.map(([level, message]) => `${level} ${message}`)).toEqual([
      "warn readiness check failing",
    ])
  })

  test("refuses a timeout or cache window it cannot honour", () => {
    expect(() => healthcheck({ timeoutMs: 0 })).toThrow(RangeError)
    expect(() => healthcheck({ timeoutMs: Number.NaN })).toThrow(RangeError)
    expect(() => healthcheck({ checks: { db: { check: () => true, timeoutMs: -1 } } })).toThrow(
      /checks\.db\.timeoutMs/,
    )
    expect(() => healthcheck({ cacheMs: -1 })).toThrow(RangeError)
    expect(() => healthcheck({ cacheMs: Number.POSITIVE_INFINITY })).toThrow(RangeError)
  })

  test("honors custom paths", async () => {
    const app = server().use(healthcheck({ path: "/livez", readyPath: "/readyz" }))
    expect((await app.fetch(new Request("http://x/livez"))).status).toBe(200)
    expect((await app.fetch(new Request("http://x/readyz"))).status).toBe(200)
  })

  test("a second instance on other paths serves them too", async () => {
    const app = server()
      .use(healthcheck())
      .use(healthcheck({ path: "/internal/health", readyPath: "/internal/ready" }))
    expect((await app.fetch(new Request("http://x/health"))).status).toBe(200)
    expect((await app.fetch(new Request("http://x/internal/health"))).status).toBe(200)
    expect((await app.fetch(new Request("http://x/internal/ready"))).status).toBe(200)
  })
})
