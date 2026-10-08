import { describe, expect, test } from "bun:test"
import {
  FakeModelGateway,
  MODEL_GATEWAY_ERROR_CODES,
  ReplayModelGateway,
  runModelGateway,
  structuredOutputParser,
} from "../src/index.ts"

const success = (output: unknown) => ({ ok: true as const, output })

describe("model gateway", () => {
  test("an attempt the deadline ends is aborted for the adapter", async () => {
    let seen: AbortSignal | undefined
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
      { routes: ["a"], retryableCodes: [], deadlineAt: Date.now() + 5 },
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
      { routes: ["a"], retryableCodes: [], deadlineAt: Date.now() + 5 },
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
