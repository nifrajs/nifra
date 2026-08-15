import { describe, expect, test } from "bun:test"
import {
  assertStaticBoundaryImports,
  type Boundary,
  type BoundaryRequestCtx,
  boundaryDescriptors,
  MemoryStaticBoundaryCache,
  resolveDynamicBoundaries,
  resolveStaticBoundaries,
  startDynamicBoundaries,
} from "../src/boundary.ts"

const context = (): BoundaryRequestCtx => ({
  request: new Request("https://example.test/users/7"),
  params: { id: "7" },
  api: { label: "api" },
  env: { region: "test" },
  draft: false,
  search: { tab: "overview" },
  signal: new AbortController().signal,
})

/** Run `body` with `console.error` captured, so a boundary failure's safe server-side report is asserted
 * rather than printed into the test output. */
const captureServerErrors = async (body: () => Promise<void>): Promise<unknown[][]> => {
  const captured: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]): void => {
    captured.push(args)
  }
  try {
    await body()
  } finally {
    console.error = original
  }
  return captured
}

describe("async boundaries", () => {
  test("describes modes without importing a UI framework", () => {
    const definitions: [Boundary<string, string>, Boundary<number, string>] = [
      { name: "feed", mode: "dynamic", load: async () => "ok", render: (data) => data },
      { name: "shell", mode: "static", render: (data) => String(data) },
    ]
    expect(boundaryDescriptors(definitions)).toEqual([
      { name: "feed", mode: "dynamic", hasLoad: true },
      { name: "shell", mode: "static", hasLoad: false },
    ])
  })

  test("runs dynamic boundaries concurrently and isolates contexts", async () => {
    let active = 0
    let peak = 0
    const seenParams: string[] = []
    const make = (name: string): Boundary<string, string> => ({
      name,
      mode: "dynamic",
      load: async (ctx) => {
        active++
        peak = Math.max(peak, active)
        seenParams.push(ctx.params.id ?? "")
        await Bun.sleep(2)
        active--
        return name
      },
      render: (data) => data,
    })
    const states = await resolveDynamicBoundaries([make("left"), make("right")], context())
    expect(peak).toBe(2)
    expect(seenParams).toEqual(["7", "7"])
    expect(states.left?.status).toBe("ready")
    expect(states.right?.status).toBe("ready")
  })

  test("contains one failure without rejecting siblings or logging raw non-Error values", async () => {
    let states: Awaited<ReturnType<typeof resolveDynamicBoundaries>> = {}
    const reported = await captureServerErrors(async () => {
      states = await resolveDynamicBoundaries(
        [
          {
            name: "bad",
            mode: "dynamic",
            load: () => Promise.reject("secret payload"),
            render: (data: unknown) => data,
          },
          { name: "good", mode: "dynamic", load: async () => 7, render: (data) => data },
        ],
        context(),
      )
    })
    expect(states.bad).toMatchObject({
      status: "error",
      error: { name: "Error", message: "Boundary failed" },
    })
    expect(states.bad?.error?.message).not.toContain("secret")
    expect(states.good).toMatchObject({ status: "ready", data: 7 })
    expect(reported).toHaveLength(1)
    expect(reported[0]).toEqual(["[nifra/web] boundary load failed", { kind: "string" }])
    expect(JSON.stringify(reported)).not.toContain("secret payload")
  })

  test("keeps a thrown Error's own message off the client state and on the server", async () => {
    // Boundary states are serialized into the document, so this message would otherwise be published
    // to every visitor who loads the page while the dependency is down.
    const secret = "connect ECONNREFUSED 10.0.0.5:5432 user=admin password=hunter2"
    let states: Awaited<ReturnType<typeof resolveDynamicBoundaries>> = {}
    const reported = await captureServerErrors(async () => {
      states = await resolveDynamicBoundaries(
        [
          {
            name: "feed",
            mode: "dynamic",
            load: () => {
              throw new Error(secret)
            },
            render: (data: unknown) => data,
          },
        ],
        context(),
      )
    })
    expect(states.feed).toMatchObject({
      status: "error",
      error: { name: "Error", message: "Boundary failed" },
    })
    expect(JSON.stringify(states)).not.toContain("hunter2")
    expect(reported).toHaveLength(1)
    expect(reported[0]).toEqual(["[nifra/web] boundary load failed", { kind: "error" }])
    expect(JSON.stringify(reported)).not.toContain("hunter2")
  })

  test("withholds an Error subclass name, which names the failing internal library", async () => {
    class SequelizeConnectionRefusedError extends Error {
      override readonly name = "SequelizeConnectionRefusedError"
    }
    let states: Awaited<ReturnType<typeof resolveDynamicBoundaries>> = {}
    await captureServerErrors(async () => {
      states = await resolveDynamicBoundaries(
        [
          {
            name: "feed",
            mode: "dynamic",
            load: () => Promise.reject(new SequelizeConnectionRefusedError("down")),
            render: (data: unknown) => data,
          },
        ],
        context(),
      )
    })
    expect(states.feed?.error).toEqual({ name: "Error", message: "Boundary failed" })
  })

  test("a failed static boundary is redacted the same way", async () => {
    let states: Awaited<ReturnType<typeof resolveStaticBoundaries>> = {}
    const reported = await captureServerErrors(async () => {
      states = await resolveStaticBoundaries(
        [
          {
            name: "shell",
            mode: "static",
            load: () => {
              throw new Error("/Users/build/secrets.json is unreadable")
            },
            render: (data: unknown) => data,
          },
        ],
        { phase: "build" },
        new MemoryStaticBoundaryCache(),
      )
    })
    expect(states.shell).toMatchObject({
      status: "error",
      error: { name: "Error", message: "Boundary failed" },
    })
    expect(JSON.stringify(states)).not.toContain("secrets.json")
    expect(reported).toHaveLength(1)
  })

  test("publishes pending slots immediately and settles each slot independently", async () => {
    let releaseSlow!: (value: string) => void
    const slow = new Promise<string>((resolve) => {
      releaseSlow = resolve
    })
    const batch = startDynamicBoundaries(
      [
        { name: "slow", mode: "dynamic", load: () => slow, render: (data) => data },
        { name: "fast", mode: "dynamic", load: async () => "fast", render: (data) => data },
      ],
      context(),
    )
    expect(batch.initial.slow?.status).toBe("pending")
    expect(batch.initial.fast?.status).toBe("pending")
    await expect(batch.pending[1]?.promise).resolves.toBe("fast")
    releaseSlow("slow")
    await expect(batch.complete).resolves.toMatchObject({
      slow: { status: "ready", data: "slow" },
      fast: { status: "ready", data: "fast" },
    })
  })

  test("resolves only annotated static slots with a request-free context and caches them", async () => {
    let loads = 0
    const cache = new MemoryStaticBoundaryCache()
    const definitions = [
      {
        name: "shell",
        mode: "static" as const,
        load: async (ctx: { readonly phase: "build"; readonly origin?: string }) => {
          loads++
          return `${ctx.phase}:${ctx.origin}`
        },
        render: (data: string) => data,
      },
      {
        name: "hole",
        mode: "dynamic" as const,
        load: async () => "request",
        render: (data: string) => data,
      },
    ]
    const first = await resolveStaticBoundaries(
      definitions,
      { phase: "build", origin: "https://example.test" },
      cache,
    )
    const second = await resolveStaticBoundaries(
      definitions,
      { phase: "build", origin: "https://other.test" },
      cache,
    )
    expect(loads).toBe(1)
    expect(first.shell).toMatchObject({ status: "ready", data: "build:https://example.test" })
    expect(second.hole?.status).toBe("unresolved")
  })

  test("fails closed when a static subtree reaches a request-scoped module", () => {
    expect(() =>
      assertStaticBoundaryImports(
        [{ name: "shell", module: "routes/shell.ts" }],
        [
          { from: "routes/shell.ts", to: "ui/card.ts" },
          { from: "ui/card.ts", to: "auth/session.ts" },
        ],
        new Set(["auth/session.ts"]),
      ),
    ).toThrow(/static boundary "shell" reaches request-scoped module/)
    expect(() =>
      assertStaticBoundaryImports(
        [{ name: "shell", module: "routes/shell.ts" }],
        [{ from: "routes/shell.ts", to: "ui/card.ts" }],
        new Set(["auth/session.ts"]),
      ),
    ).not.toThrow()
  })

  test("rejects duplicate names and unsafe intercept paths", () => {
    expect(() =>
      boundaryDescriptors([
        { name: "same", mode: "dynamic", render: () => null },
        { name: "same", mode: "dynamic", render: () => null },
      ]),
    ).toThrow(/duplicate boundary name/)
    expect(() =>
      boundaryDescriptors([
        { name: "modal", mode: { intercept: "//evil.test" }, render: () => null },
      ]),
    ).toThrow(/same-origin path/)
  })
})
