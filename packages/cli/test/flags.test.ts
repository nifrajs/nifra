import { afterEach, expect, test } from "bun:test"
import { DEFAULT_DEV_PORT } from "@nifrajs/web"
import { formatCliError, parseFlags } from "../src/cli.ts"

// parseFlags reads Bun.env.PORT; snapshot + restore so tests don't leak the override into each other.
const savedPort = Bun.env.PORT
afterEach(() => {
  if (savedPort === undefined) delete Bun.env.PORT
  else Bun.env.PORT = savedPort
})

test("parseFlags defaults to the shared uncommon DEFAULT_DEV_PORT (no flag, no env)", () => {
  delete Bun.env.PORT
  expect(parseFlags([]).port).toBe(DEFAULT_DEV_PORT)
  expect(parseFlags([]).target).toBe("bun")
  expect(DEFAULT_DEV_PORT).not.toBe(3000) // the whole point: not the colliding default
})

test("parseFlags honors the PORT env override", () => {
  Bun.env.PORT = "5050"
  expect(parseFlags([]).port).toBe(5050)
})

test("parseFlags: --port (and -p alias) beats the PORT env", () => {
  Bun.env.PORT = "5050"
  expect(parseFlags(["--port", "8123"]).port).toBe(8123)
  expect(parseFlags(["-p", "8124"]).port).toBe(8124)
})

test("parseFlags rejects an out-of-range / non-numeric port", () => {
  delete Bun.env.PORT
  expect(() => parseFlags(["--port", "70000"])).toThrow(/invalid --port/)
  expect(() => parseFlags(["--port", "-1"])).toThrow(/invalid --port/)
  expect(() => parseFlags(["--port", "abc"])).toThrow(/invalid --port/)
})

test("parseFlags parses --out and --poll independently of port", () => {
  delete Bun.env.PORT
  const flags = parseFlags(["--out", "build", "--poll"])
  expect(flags.out).toBe("build")
  expect(flags.poll).toBe(true)
  expect(flags.port).toBe(DEFAULT_DEV_PORT)
})

// `Bun.build` reports a bundle failure as an AggregateError whose `.message` is a generic "Bundle
// failed" and whose `.errors` hold the real causes. A catch printing only `.message` throws them away.
test("formatCliError unwraps an AggregateError's causes instead of the generic head", () => {
  const agg = new AggregateError(
    [new Error("Could not resolve ./db from routes/x.tsx"), new Error("Expected ; but found }")],
    "Bundle failed",
  )
  const out = formatCliError(agg)
  expect(out).toContain("Could not resolve ./db from routes/x.tsx")
  expect(out).toContain("Expected ; but found }")
  expect(out).not.toBe("Bundle failed") // the detail is surfaced, not dropped
})

test("formatCliError unwraps an AggregateError carried as a .cause", () => {
  const wrapped = new Error("server build failed", {
    cause: new AggregateError([new Error("missing entrypoint")], "Bundle failed"),
  })
  expect(formatCliError(wrapped)).toContain("missing entrypoint")
})

test("formatCliError deduplicates a cause Bun repeats across .errors", () => {
  const agg = new AggregateError([new Error("same"), new Error("same")], "Bundle failed")
  const lines = formatCliError(agg)
    .split("\n")
    .filter((line) => line.includes("same"))
  expect(lines).toHaveLength(1)
})

test("formatCliError falls back to the message for a plain Error, and String for a non-error", () => {
  expect(formatCliError(new Error("plain boom"))).toBe("plain boom")
  expect(formatCliError("just a string")).toBe("just a string")
})
