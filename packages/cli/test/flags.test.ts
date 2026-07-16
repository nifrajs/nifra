import { afterEach, expect, test } from "bun:test"
import { DEFAULT_DEV_PORT } from "@nifrajs/web"
import { parseFlags } from "../src/cli.ts"

// parseFlags reads Bun.env.PORT; snapshot + restore so tests don't leak the override into each other.
const savedPort = Bun.env.PORT
afterEach(() => {
  if (savedPort === undefined) delete Bun.env.PORT
  else Bun.env.PORT = savedPort
})

test("parseFlags defaults to the shared uncommon DEFAULT_DEV_PORT (no flag, no env) [#5]", () => {
  delete Bun.env.PORT
  expect(parseFlags([]).port).toBe(DEFAULT_DEV_PORT)
  expect(parseFlags([]).target).toBe("bun")
  expect(DEFAULT_DEV_PORT).not.toBe(3000) // the whole point: not the colliding default
})

test("parseFlags honors the PORT env override [#5]", () => {
  Bun.env.PORT = "5050"
  expect(parseFlags([]).port).toBe(5050)
})

test("parseFlags: --port (and -p alias) beats the PORT env [#5]", () => {
  Bun.env.PORT = "5050"
  expect(parseFlags(["--port", "8123"]).port).toBe(8123)
  expect(parseFlags(["-p", "8124"]).port).toBe(8124)
})

test("parseFlags rejects an out-of-range / non-numeric port [#5]", () => {
  delete Bun.env.PORT
  expect(() => parseFlags(["--port", "70000"])).toThrow(/invalid --port/)
  expect(() => parseFlags(["--port", "-1"])).toThrow(/invalid --port/)
  expect(() => parseFlags(["--port", "abc"])).toThrow(/invalid --port/)
})

test("parseFlags parses --out and --poll independently of port [#5]", () => {
  delete Bun.env.PORT
  const flags = parseFlags(["--out", "build", "--poll"])
  expect(flags.out).toBe("build")
  expect(flags.poll).toBe(true)
  expect(flags.port).toBe(DEFAULT_DEV_PORT)
})
