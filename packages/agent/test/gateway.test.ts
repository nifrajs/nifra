import { describe, expect, spyOn, test } from "bun:test"
import {
  createStructuredOutputParser,
  FakeModelGateway,
  MODEL_GATEWAY_ERROR_CODES,
  ModelGatewayFailureError,
  parseModelGatewayResult,
  ReplayModelGateway,
  runModelGateway,
  structuredOutputParser,
} from "../src/index.ts"

const success = (output: unknown) => ({ ok: true as const, output })

describe("model gateway", () => {
  test("a deadline beyond setTimeout's range is waited out in chunks", async () => {
    const maxTimerMs = 2_147_483_647
    const realSetTimeout = globalThis.setTimeout
    const armed: { readonly fire: () => void; readonly delay: number }[] = []
    let onArm = (): void => {}
    const record = (handler: unknown, delay?: number) => {
      if (typeof handler === "function") armed.push({ fire: () => handler(), delay: delay ?? 0 })
      onArm()
      return realSetTimeout(() => {}, 0)
    }
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a recorder cannot meet every setTimeout overload; the gateway only ever passes a callback and a delay
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(record as never)
    try {
      const nextArm = () => new Promise<void>((resolve) => (onArm = resolve))
      const first = nextArm()
      const running = runModelGateway(
        {
          complete: (request) =>
            new Promise((resolve) =>
              request.signal.addEventListener("abort", () =>
                resolve({ ok: false, error: { code: "cancelled" } }),
              ),
            ),
        },
        { input: "x" },
        { routes: ["a"], retryableCodes: [], deadlineAt: 1 + maxTimerMs + 1_000, now: () => 1 },
      )
      await first
      expect(armed.map((timer) => timer.delay)).toEqual([maxTimerMs])
      const second = nextArm()
      armed[0]?.fire()
      await second
      expect(armed.map((timer) => timer.delay)).toEqual([maxTimerMs, 1_000])
      armed[1]?.fire()
      const result = await running
      expect(result.ok ? "ok" : result.error.code).toBe("timeout")
    } finally {
      timers.mockRestore()
    }
  })

  test("a policy at the attempt cap runs every attempt, even the costliest kind", async () => {
    const gateway = new FakeModelGateway({
      responses: Array.from({ length: 512 }, () => success("not json")),
    })
    const result = await runModelGateway(
      gateway,
      {
        input: {},
        parser: structuredOutputParser(() => {
          throw new Error("bad output")
        }),
      },
      {
        routes: ["route-a", "route-b"],
        retryableCodes: ["malformed_output"],
        allowFallback: true,
        budget: { maxAttempts: 512 },
      },
    )
    expect(result.ok ? "ok" : result.error.code).toBe("unavailable")
    expect(result.attempts).toBe(512)
    expect(gateway.calls).toBe(512)
  })

  test("an attempt the deadline ends is aborted for the adapter", async () => {
    let seen: AbortSignal | undefined
    // A fixed clock: the adapter is reached however long the run takes to get there.
    const result = await runModelGateway(
      {
        complete: (request) => {
          seen = request.signal
          return new Promise((resolve) => {
            request.signal.addEventListener("abort", () =>
              resolve({ ok: false, error: { code: "cancelled" } }),
            )
          })
        },
      },
      { input: "x" },
      { routes: ["a"], retryableCodes: [], deadlineAt: 5, now: () => 0 },
    )
    expect(result.ok ? "ok" : result.error.code).toBe("timeout")
    expect(seen?.aborted).toBe(true)
  })

  test("a caller's cancellation aborts the attempt's signal", async () => {
    const caller = new AbortController()
    let seen: AbortSignal | undefined
    const pending = runModelGateway(
      {
        complete: (request) => {
          seen = request.signal
          caller.abort()
          return new Promise(() => {})
        },
      },
      { input: "x", signal: caller.signal },
      { routes: ["a"], retryableCodes: [] },
    )
    const result = await pending
    expect(result.ok ? "ok" : result.error.code).toBe("cancelled")
    expect(seen?.aborted).toBe(true)
  })

  test("the deadline covers the parser, and a late parse is not a success", async () => {
    const result = await runModelGateway(
      { complete: () => success("x") },
      { input: "x", parser: { parse: () => new Promise<string>(() => {}) } },
      { routes: ["a"], retryableCodes: [], deadlineAt: 5, now: () => 0 },
    )
    expect(result.ok ? "ok" : result.error.code).toBe("timeout")
    let now = 0
    const late = await runModelGateway(
      { complete: () => success("x") },
      {
        input: "x",
        parser: {
          parse: (value: unknown) => {
            now = 100
            return value
          },
        },
      },
      { routes: ["a"], retryableCodes: [], deadlineAt: 50, now: () => now },
    )
    expect(late.ok ? "ok" : late.error.code).toBe("timeout")
  })

  test("parses structured output and keeps evidence content-free", async () => {
    const gateway = new FakeModelGateway({ responses: [success({ answer: 42 })] })
    const result = await runModelGateway(
      gateway,
      {
        input: { prompt: "transient" },
        parser: structuredOutputParser((value) => {
          if (
            value === null ||
            typeof value !== "object" ||
            (value as { answer?: unknown }).answer !== 42
          )
            throw new Error("invalid")
          return value as { answer: number }
        }),
      },
      { routes: ["route-a"], retryableCodes: [], budget: { maxAttempts: 1 } },
    )
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result.evidence)).not.toContain("prompt")
    expect(result.evidence.at(-1)?.kind).toBe("terminal")
  })

  test("classifies malformed structured output and refuses undeclared retry", async () => {
    const gateway = new FakeModelGateway({ responses: [success({ wrong: true })] })
    const result = await runModelGateway(
      gateway,
      {
        input: {},
        parser: structuredOutputParser(() => {
          throw new Error("bad output")
        }),
      },
      { routes: ["route-a"], retryableCodes: [], budget: { maxAttempts: 4 } },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("malformed_output")
      expect(result.attempts).toBe(1)
    }
  })

  test("falls back only for caller-declared codes and records the route change", async () => {
    const gateway = new FakeModelGateway({
      responses: [{ ok: false, error: { code: "rate_limit" } }, success("ok")],
    })
    const result = await runModelGateway(
      gateway,
      { input: {} },
      {
        routes: ["primary", "fallback"],
        retryableCodes: ["rate_limit"],
        allowFallback: true,
        budget: { maxAttempts: 2 },
      },
    )
    expect(result.ok).toBe(true)
    expect(result.routeId).toBe("fallback")
    expect(result.evidence.some((item) => item.kind === "fallback")).toBe(true)
  })

  test("preserves monotonic attempt and token envelopes", async () => {
    const envelopes: { attemptsRemaining: number; inputTokensRemaining?: number }[] = []
    const gateway = {
      complete(request: {
        envelope: { attemptsRemaining: number; inputTokensRemaining?: number }
      }) {
        envelopes.push({ ...request.envelope })
        return { ok: false as const, error: { code: "unavailable" as const } }
      },
    }
    const result = await runModelGateway(
      gateway,
      { input: {} },
      {
        routes: ["route-a"],
        retryableCodes: ["unavailable"],
        budget: { maxAttempts: 3, maxInputTokens: 10 },
      },
    )
    expect(result.ok).toBe(false)
    expect(envelopes.map((item) => item.attemptsRemaining)).toEqual([2, 1, 0])
    expect(envelopes.map((item) => item.inputTokensRemaining)).toEqual([10, 10, 10])
  })

  test("covers the stable error taxonomy through replay without network", async () => {
    for (const code of MODEL_GATEWAY_ERROR_CODES) {
      const gateway = new ReplayModelGateway({
        replayId: `replay-${code}`,
        responses: [{ ok: false, error: { code } }],
      })
      const result = await runModelGateway(
        gateway,
        { input: {} },
        { routes: ["route-a"], retryableCodes: [], budget: { maxAttempts: 1 } },
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe(code)
    }
  })
})

describe("model gateway result parsing", () => {
  test("a leaf result with an odd shape becomes a code, never the raw value", () => {
    expect(parseModelGatewayResult("ok")).toEqual({ ok: false, error: { code: "internal" } })
    expect(parseModelGatewayResult({ ok: false, error: { code: "timeout" }, trace: "x" })).toEqual({
      ok: false,
      error: { code: "malformed_output" },
    })
    expect(parseModelGatewayResult({ ok: false, error: { code: "timeout", detail: "x" } })).toEqual(
      { ok: false, error: { code: "internal" } },
    )
    expect(
      parseModelGatewayResult({ ok: false, error: new ModelGatewayFailureError("cancelled") }),
    ).toEqual({ ok: false, error: { code: "cancelled" } })
    expect(parseModelGatewayResult({ ok: true, output: 1, extra: true })).toEqual({
      ok: false,
      error: { code: "malformed_output" },
    })
    expect(parseModelGatewayResult({ ok: true })).toEqual({
      ok: false,
      error: { code: "malformed_output" },
    })
    expect(parseModelGatewayResult({ ok: true, output: 1, usage: { inputTokens: -1 } })).toEqual({
      ok: false,
      error: { code: "malformed_output" },
    })
    expect(parseModelGatewayResult({ ok: true, output: 1, usage: "many" })).toEqual({
      ok: false,
      error: { code: "malformed_output" },
    })
    expect(
      parseModelGatewayResult({ ok: true, output: 1, usage: { inputTokens: 3, outputTokens: 4 } }),
    ).toEqual({ ok: true, output: 1, usage: { inputTokens: 3, outputTokens: 4 } })
  })

  test("a Standard Schema parser turns an invalid output into malformed_output", async () => {
    const parser = createStructuredOutputParser({
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) =>
          typeof value === "string" ? { value } : { issues: [{ message: "not a string" }] },
      },
    })
    const run = (output: unknown) =>
      runModelGateway(
        new FakeModelGateway({ responses: [success(output)] }),
        { input: {}, parser },
        { routes: ["a"], retryableCodes: [] },
      )
    const good = await run("answer")
    expect(good.ok ? good.output : good.error.code).toBe("answer")
    const bad = await run(42)
    expect(bad.ok ? "ok" : bad.error.code).toBe("malformed_output")
  })
})

describe("model gateway policy checks", () => {
  const gateway = () => new FakeModelGateway({ responses: [success("x")] })

  test("refuses a gateway without complete and a policy out of bounds", async () => {
    await expect(
      runModelGateway({} as never, { input: {} }, { routes: ["a"], retryableCodes: [] }),
    ).rejects.toThrow("model gateway must implement complete")
    const refused: [Parameters<typeof runModelGateway>[2], string][] = [
      [{ routes: [], retryableCodes: [] }, "policy requires bounded routes"],
      [{ routes: ["a", "a"], retryableCodes: [] }, "routes must be unique"],
      [{ routes: ["a"], retryableCodes: [], budget: { maxAttempts: 0 } }, "maxAttempts is invalid"],
      [
        { routes: ["a"], retryableCodes: [], budget: { maxAttempts: 1, maxInputTokens: -1 } },
        "maxInputTokens is invalid",
      ],
      [
        { routes: ["a"], retryableCodes: [], budget: { maxAttempts: 1, maxOutputTokens: 1.5 } },
        "maxOutputTokens is invalid",
      ],
      [{ routes: ["a"], retryableCodes: [], maxAttempts: 0 }, "policy maxAttempts is invalid"],
      [{ routes: ["a"], retryableCodes: [], deadlineAt: 0 }, "deadlineAt is invalid"],
    ]
    for (const [policy, message] of refused)
      await expect(runModelGateway(gateway(), { input: {} }, policy)).rejects.toThrow(message)
  })

  test("a route outside the policy is denied before any attempt", async () => {
    const fake = gateway()
    const result = await runModelGateway(
      fake,
      { input: {}, routeId: "elsewhere" },
      { routes: ["a"], retryableCodes: [] },
    )
    expect(result.ok ? "ok" : result.error.code).toBe("policy_denied")
    expect(result.attempts).toBe(0)
    expect(fake.calls).toBe(0)
  })

  test("an answer that spends past the token budget is denied", async () => {
    const result = await runModelGateway(
      new FakeModelGateway({ responses: [{ ok: true, output: "x", usage: { outputTokens: 50 } }] }),
      { input: {} },
      { routes: ["a"], retryableCodes: [], budget: { maxAttempts: 1, maxOutputTokens: 10 } },
    )
    expect(result.ok ? "ok" : result.error.code).toBe("policy_denied")
    expect(result.evidence.at(-2)).toMatchObject({ outcome: "failed", code: "policy_denied" })
  })

  test("fake and replay gateways refuse more responses than attempts can use", () => {
    const responses = Array.from({ length: 513 }, () => success("x"))
    expect(() => new FakeModelGateway({ responses })).toThrow(
      "fake gateway responses are unbounded",
    )
    expect(() => new ReplayModelGateway({ replayId: "replay-1", responses })).toThrow(
      "replay gateway responses are unbounded",
    )
    const replay = new ReplayModelGateway({ replayId: "replay-1", responses: [success("x")] })
    expect(replay.calls).toBe(0)
    replay.complete({
      routeId: "a",
      input: {},
      envelope: { attempt: 1, attemptsRemaining: 0 },
    } as never)
    expect(replay.calls).toBe(1)
  })
})
