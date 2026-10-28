import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DEFAULT_DEV_PORT } from "@nifrajs/web"
import {
  assureBundleRequested,
  commandArgv,
  formatCliError,
  frontendCommandInput,
  parseFlags,
} from "../src/cli.ts"

// parseFlags reads Bun.env.PORT; snapshot + restore so tests don't leak the override into each other.
const savedPort = Bun.env.PORT
afterEach(() => {
  if (savedPort === undefined) delete Bun.env.PORT
  else Bun.env.PORT = savedPort
})

test("parseFlags defaults to the shared uncommon DEFAULT_DEV_PORT (no flag, no env)", () => {
  delete Bun.env.PORT
  expect(parseFlags([]).port).toBe(DEFAULT_DEV_PORT)
  expect(parseFlags([]).target).toBeUndefined()
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
  expect(() => parseFlags(["--port=-1"])).toThrow(/invalid --port/)
  expect(() => parseFlags(["--port", "abc"])).toThrow(/invalid --port/)
})

test("parseFlags parses --out and --poll independently of port", () => {
  delete Bun.env.PORT
  const flags = parseFlags(["--out", "build", "--poll"])
  expect(flags.out).toBe("build")
  expect(flags.poll).toBe(true)
  expect(flags.port).toBe(DEFAULT_DEV_PORT)
})

test("parseFlags parses --allow-duplicate-identity (default off)", () => {
  delete Bun.env.PORT
  expect(parseFlags([]).allowDuplicateIdentity).toBe(false)
  expect(parseFlags(["--allow-duplicate-identity"]).allowDuplicateIdentity).toBe(true)
})

test("parseFlags parses --no-indicator (default off)", () => {
  expect(parseFlags([]).noIndicator).toBe(false)
  expect(parseFlags(["--no-indicator"]).noIndicator).toBe(true)
})

test("parseFlags reads --flag=value as --flag value", () => {
  delete Bun.env.PORT
  const flags = parseFlags(["--target=vercel", "--out=build", "--port=8125", "--report=true"])
  expect(flags.target).toBe("vercel")
  expect(flags.out).toBe("build")
  expect(flags.port).toBe(8125)
  expect(flags.report).toBe(true)
  expect(parseFlags(["--report=false"]).report).toBe(false)
})

test("parseFlags refuses an unknown flag, a stray argument, or a flag missing its value", () => {
  expect(() => parseFlags(["--targt", "vercel"])).toThrow("[nifra] unknown option: --targt")
  expect(() => parseFlags(["--target-vercel"])).toThrow("[nifra] unknown option: --target-vercel")
  expect(() => parseFlags(["vercel"])).toThrow("[nifra] unexpected argument: vercel")
  expect(() => parseFlags(["--target"])).toThrow("[nifra] --target needs a value")
  expect(() => parseFlags(["--target="])).toThrow("[nifra] --target needs a value")
  expect(() => parseFlags(["--out", "--poll"])).toThrow("[nifra] --out needs a value")
  expect(() => parseFlags(["--port", "-1"])).toThrow("[nifra] --port needs a value")
  expect(() => parseFlags(["--poll=yes"])).toThrow("[nifra] --poll takes no value")
  expect(() => parseFlags(["constructor"])).toThrow("[nifra] unexpected argument: constructor")
})

test("`nifra build` refuses a mistyped flag before building, and `--help` prints the usage", async () => {
  const cli = resolve(import.meta.dir, "../src/cli.ts")
  const run = async (args: readonly string[]) => {
    const proc = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exit }
  }
  const mistyped = await run(["build", "--targt=vercel"])
  expect(mistyped.exit).toBe(1)
  expect(mistyped.stderr).toContain("[nifra] unknown option: --targt=vercel")
  const help = await run(["build", "--help"])
  expect(help.exit).toBe(0)
  expect(help.stdout).toContain("nifra build   [--out <dir>] [--report]")
})

test("a catalog command prints its own usage for --help and with a missing subcommand", async () => {
  const cli = resolve(import.meta.dir, "../src/cli.ts")
  const run = async (args: readonly string[]) => {
    const proc = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exit }
  }
  const help = await run(["contracts", "--help"])
  expect(help.exit).toBe(0)
  expect(help.stdout).toStartWith("Usage:\n  nifra contracts snapshot [--out <file>]")
  expect(help.stdout).toContain("nifra contracts check [--out <file>] [--json]")
  const bare = await run(["contracts"])
  expect(bare.exit).toBe(1)
  expect(bare.stderr).toContain("[nifra] action must be snapshot or check\n\nUsage:")
  expect(bare.stderr).toContain("nifra contracts snapshot [--out <file>]")
  const db = await run(["db", "schema", "-h"])
  expect(db.exit).toBe(0)
  expect(db.stdout).toContain("nifra db schema [<table>]")
})

test("a command that fails under --json still prints one JSON document on stdout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nifra-json-error-"))
  try {
    for (const args of [
      ["routes", "--json"],
      ["check", "--json", "--bogus"],
      ["build", "--json"],
    ]) {
      const proc = Bun.spawn(
        [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args],
        {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(exit).toBe(1)
      const parsed: unknown = JSON.parse(stdout)
      expect(parsed).toEqual({ ok: false, error: stderr.trim() })
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("frontend command keeps flags out of adapter and symptom parsing", async () => {
  const cli = resolve(import.meta.dir, "../src/cli.ts")
  const run = async (args: readonly string[]) => {
    const proc = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exit }
  }

  const json = await run(["frontend", "--json", "vue", "list", "reorder", "state"])
  expect(json.exit).toBe(0)
  expect(json.stderr).toBe("")
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the CLI JSON contract is asserted field-by-field below.
  const parsed = JSON.parse(json.stdout) as {
    adapter?: string
    symptom?: string
    matched: boolean
    entries: unknown[]
  }
  expect(parsed.adapter).toBe("vue")
  expect(parsed.symptom).toBe("list reorder state")
  expect(parsed.matched).toBe(true)
  expect(parsed.entries.length).toBeGreaterThan(0)

  const adapterOnly = await run(["frontend", "--json", "vue"])
  expect(JSON.parse(adapterOnly.stdout).symptom).toBeUndefined()

  const noAdapter = await run(["frontend", "--json", "hydration", "mismatch"])
  expect(JSON.parse(noAdapter.stdout).symptom).toBe("hydration mismatch")

  const prose = await run(["frontend", "vue", "list", "reorder"])
  expect(prose.exit).toBe(0)
  expect(prose.stdout).toContain("[list-key]")
  expect(() => JSON.parse(prose.stdout)).toThrow()
})

test("frontendCommandInput preserves the observable empty-symptom boundary", () => {
  const parse = (value: string | undefined) =>
    value?.trim().toLowerCase() === "vue" ? "vue" : undefined
  expect(frontendCommandInput(["--json", "vue"], parse)).toEqual({
    adapter: "vue",
    symptom: undefined,
    json: true,
  })
  expect(frontendCommandInput(["--json", "hydration", "mismatch"], parse)).toEqual({
    adapter: undefined,
    symptom: "hydration mismatch",
    json: true,
  })
})

// Guards the regression: `assure --json` must stay the {ok,routes,findings} report. The bundle is
// opt-in, so bare --json (or no flag) never routes to the {gates,verdict} lane.
test("assureBundleRequested: --json alone is the report; --bundle and bundle-only flags opt in", () => {
  expect(assureBundleRequested([])).toBe(false)
  expect(assureBundleRequested(["--json"])).toBe(false)
  expect(assureBundleRequested(["--bundle"])).toBe(true)
  expect(assureBundleRequested(["--bundle", "--json"])).toBe(true)
  for (const flag of ["--strict", "--hydration", "--interact", "--out"])
    expect(assureBundleRequested([flag])).toBe(true)
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

test("a configured Bun child recovers its command vector when argv is empty", async () => {
  const cli = resolve(import.meta.dir, "../src/cli.ts")
  const config = resolve(import.meta.dir, "../../../bunfig.toml")
  const proc = Bun.spawn([process.execPath, `--config=${config}`, cli], {
    cwd: resolve(import.meta.dir, "../../.."),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NIFRA_BUN_DEV_TOKEN: "test-launch-token",
      NIFRA_BUN_DEV_DEPTH: "1",
      NIFRA_BUN_DEV_ARGS: JSON.stringify(["--version"]),
    },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(code).toBe(0)
  expect(stderr).toBe("")
  expect(stdout).toContain("nifra (@nifrajs/cli)")
})

test("arguments typed before the command follow it instead of being dropped", () => {
  const runtime = ["/usr/local/bin/bun", "/app/node_modules/.bin/nifra"]
  expect(commandArgv([...runtime, "--json", "check"], 3)).toEqual(["check", "--json"])
  expect(commandArgv([...runtime, "--env-file", ".env", "upgrade", "4.0.0"], 4)).toEqual([
    "upgrade",
    "4.0.0",
    "--env-file",
    ".env",
  ])
  expect(commandArgv([...runtime, "--json", "run", "--", "x"], 3)).toEqual([
    "run",
    "--json",
    "--",
    "x",
  ])
  expect(commandArgv([...runtime, "check", "--json"], 2)).toEqual(["check", "--json"])
  // A runtime flag at index 1: what precedes the command is the runtime's, not the caller's.
  expect(commandArgv(["bun", "--config=a.toml", "/app/cli.ts", "dev"], 3)).toEqual(["dev"])
  expect(commandArgv(["dev", "--port", "3000"], 0)).toEqual(["dev", "--port", "3000"])
})
