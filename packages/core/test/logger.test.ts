import { describe, expect, test } from "bun:test"
import {
  commonSecretPatterns,
  jsonLogger,
  type Logger,
  redactLogFields,
  server,
  silentLogger,
} from "../src/index.ts"

const noop = (): void => undefined

describe("redactLogFields", () => {
  test("redacts sensitive keys, keeps the rest, deeply and inside arrays", () => {
    const out = redactLogFields({
      user: "ada",
      password: "hunter2",
      Authorization: "Bearer x",
      nested: { apiKey: "k", count: 3 },
      list: [{ token: "t" }, { ok: true }],
    })
    expect(out).toEqual({
      user: "ada",
      password: "[REDACTED]",
      Authorization: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", count: 3 },
      list: [{ token: "[REDACTED]" }, { ok: true }],
    })
  })

  test("is cycle-safe", () => {
    const a: Record<string, unknown> = { name: "x" }
    a.self = a
    const out = redactLogFields(a)
    expect(out.name).toBe("x")
    expect(out.self).toBe("[Circular]")
  })

  test("opt-in valuePatterns scrub secrets inside string values (key-name redaction alone misses these)", () => {
    const out = redactLogFields(
      { detail: "auth failed for a@b.com with Bearer abc.def123", count: 5 },
      { valuePatterns: commonSecretPatterns },
    )
    expect(out.detail).toBe("auth failed for [REDACTED] with [REDACTED]")
    expect(out.count).toBe(5) // non-strings untouched
  })

  test("default (no valuePatterns) does NOT scan values", () => {
    const out = redactLogFields({ detail: "token leaked: a@b.com" })
    expect(out.detail).toBe("token leaked: a@b.com") // unchanged; only key-name redaction by default
  })

  test("extra keyParts extend the denylist; placeholder is configurable", () => {
    const out = redactLogFields(
      { sessionId: "s1", user: "ada" },
      { keyParts: ["sessionId"], placeholder: "***" },
    )
    expect(out).toEqual({ sessionId: "***", user: "ada" })
  })

  test("a non-global pattern still scrubs every occurrence (normalized to global)", () => {
    const out = redactLogFields(
      { msg: "x=1 x=2 x=3" },
      { valuePatterns: [/x=\d/], placeholder: "Y" }, // no `g` flag on purpose
    )
    expect(out.msg).toBe("Y Y Y")
  })

  test("a sensitive key still wins over value scanning (whole value replaced, not partially scanned)", () => {
    const out = redactLogFields({ token: "a@b.com" }, { valuePatterns: commonSecretPatterns })
    expect(out.token).toBe("[REDACTED]")
  })
})

describe("jsonLogger", () => {
  test("emits one redacted JSON line per call, across all levels", () => {
    const lines: string[] = []
    const logger = jsonLogger((line) => lines.push(line))
    logger.debug("d")
    logger.info("i", { user: "ada" })
    logger.warn("w")
    logger.error("e", { password: "p" })
    expect(lines).toHaveLength(4)
    const info = JSON.parse(lines[1] ?? "")
    expect(info).toMatchObject({ level: "info", message: "i", user: "ada" })
    expect(typeof info.time).toBe("string")
    expect(JSON.parse(lines[3] ?? "").password).toBe("[REDACTED]")
  })

  test("framework keys are not overridden by user fields", () => {
    const lines: string[] = []
    jsonLogger((line) => lines.push(line)).info("real", { level: "FAKE", message: "FAKE" })
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "info", message: "real" })
  })

  test("valuePatterns also scrub the message (the gap the AUDIT called out)", () => {
    const lines: string[] = []
    const logger = jsonLogger((line) => lines.push(line), { valuePatterns: commonSecretPatterns })
    logger.error("login failed for user@example.com")
    expect(JSON.parse(lines[0] ?? "").message).toBe("login failed for [REDACTED]")
  })

  test("the default sink writes a line to stderr", () => {
    const original = process.stderr.write
    const written: string[] = []
    // Narrow stub for the test; restored in `finally`.
    process.stderr.write = ((chunk: unknown): boolean => {
      written.push(String(chunk))
      return true
    }) as unknown as typeof process.stderr.write
    try {
      jsonLogger().error("boom", { code: 1 })
    } finally {
      process.stderr.write = original
    }
    expect(written).toHaveLength(1)
    expect(JSON.parse((written[0] ?? "").trim())).toMatchObject({
      level: "error",
      message: "boom",
      code: 1,
    })
  })
})

describe("silentLogger", () => {
  test("discards every level without throwing", () => {
    expect(() => {
      silentLogger.debug("x")
      silentLogger.info("x")
      silentLogger.warn("x")
      silentLogger.error("x", { a: 1 })
    }).not.toThrow()
  })
})

describe("server error logging", () => {
  test("an unhandled handler error is logged structured, with no leak to the client", async () => {
    const logs: Array<{ message: string; fields: Record<string, unknown> | undefined }> = []
    const capture: Logger = {
      debug: noop,
      info: noop,
      warn: noop,
      error: (message, fields) => logs.push({ message, fields }),
    }
    const app = server({ logger: capture }).get("/boom", () => {
      throw new Error("kaboom")
    })
    const res = await app.fetch(new Request("http://x/boom"))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: "internal_error" })
    expect(logs).toHaveLength(1)
    expect(logs[0]?.fields).toMatchObject({ method: "GET", path: "/boom", detail: "kaboom" })
  })

  // The test above inspects the fields as *passed*, which is exactly why the collision hid: a field
  // named `message` looked right there and was overwritten on the way out. Assert on the record the
  // sink actually receives, through the real `jsonLogger`, so the round trip is what's covered.
  test("the thrown error's message reaches the emitted record (not clobbered by the log message)", async () => {
    const lines: string[] = []
    const app = server({ logger: jsonLogger((line) => lines.push(line)) }).get("/boom", () => {
      throw new Error("kaboom")
    })
    expect((await app.fetch(new Request("http://x/boom"))).status).toBe(500)
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0] ?? "")
    expect(entry).toMatchObject({
      level: "error",
      message: "unhandled request error", // the logger's own first argument
      method: "GET",
      path: "/boom",
      name: "Error",
      detail: "kaboom", // the error's own message, under a field the logger does not own
    })
  })

  test("a non-Error throw keeps its text, which has no `stack` to hide in", async () => {
    const lines: string[] = []
    const app = server({ logger: jsonLogger((line) => lines.push(line)) }).get("/boom", () => {
      throw "just a string"
    })
    expect((await app.fetch(new Request("http://x/boom"))).status).toBe(500)
    const entry = JSON.parse(lines[0] ?? "")
    expect(entry.detail).toBe("just a string")
    expect(entry.stack).toBeUndefined()
  })

  // What reaches the sink is the app's call. The default diagnoses; the narrower tiers exist for an
  // operator who does not trust the sink with an error's own text.
  test("errorLogDetail: 'message' keeps the text and drops the stack", async () => {
    const lines: string[] = []
    const app = server({
      logger: jsonLogger((line) => lines.push(line)),
      errorLogDetail: "message",
    }).get("/boom", () => {
      throw new Error("kaboom")
    })
    expect((await app.fetch(new Request("http://x/boom"))).status).toBe(500)
    const entry = JSON.parse(lines[0] ?? "")
    expect(entry).toMatchObject({ name: "Error", detail: "kaboom" })
    expect(entry.stack).toBeUndefined()
  })

  test("errorLogDetail: 'none' logs metadata only", async () => {
    const lines: string[] = []
    const app = server({
      logger: jsonLogger((line) => lines.push(line)),
      errorLogDetail: "none",
    }).get("/boom", () => {
      throw new Error("kaboom")
    })
    expect((await app.fetch(new Request("http://x/boom"))).status).toBe(500)
    const entry = JSON.parse(lines[0] ?? "")
    expect(entry).toMatchObject({ method: "GET", path: "/boom", name: "Error" })
    expect(entry.detail).toBeUndefined()
    expect(entry.stack).toBeUndefined()
  })

  // The leak this option is aimed at has a narrower instrument: the redacting logger scrubs the
  // secret out of the error's own text while the diagnosis survives.
  test("valuePatterns redact a secret inside the error's own text", async () => {
    const lines: string[] = []
    const app = server({
      logger: jsonLogger((line) => lines.push(line), { valuePatterns: commonSecretPatterns }),
    }).get("/boom", () => {
      throw new Error("upstream rejected sk_live_0123456789abcdef")
    })
    expect((await app.fetch(new Request("http://x/boom"))).status).toBe(500)
    const entry = JSON.parse(lines[0] ?? "")
    expect(entry.detail).toBe("upstream rejected [REDACTED]")
  })

  test("a handled error (onError returns a response) never reaches the logger", async () => {
    const logs: string[] = []
    const capture: Logger = {
      debug: noop,
      info: noop,
      warn: noop,
      error: (message) => logs.push(message),
    }
    const app = server({ logger: capture })
      .onError(() => new Response("handled", { status: 418 }))
      .get("/boom", () => {
        throw new Error("x")
      })
    const res = await app.fetch(new Request("http://x/boom"))
    expect(res.status).toBe(418)
    expect(logs).toHaveLength(0)
  })
})
