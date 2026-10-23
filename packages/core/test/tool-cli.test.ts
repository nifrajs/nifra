import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { runToolCli, TOOL_CLI_EXIT, type ToolCliStreams } from "../src/tool-cli.ts"
import {
  defineTool,
  runToolContractConformance,
  type ToolCallOptions,
} from "../src/tool-contract.ts"

interface Captured {
  readonly streams: ToolCliStreams
  readonly stdout: () => string
  readonly stderr: () => string
}

function capture(stdin?: readonly (Uint8Array | string)[]): Captured {
  let out = ""
  let err = ""
  const stdout = {
    write: (chunk: string) => {
      out += chunk
    },
  }
  const stderr = {
    write: (chunk: string) => {
      err += chunk
    },
  }
  const streams: ToolCliStreams =
    stdin === undefined
      ? { stdout, stderr }
      : {
          stdout,
          stderr,
          stdin: (async function* () {
            yield* stdin
          })(),
        }
  return { streams, stdout: () => out, stderr: () => err }
}

const calls: unknown[] = []

const search = defineTool({
  name: "search",
  description: "Search the\n  catalog.",
  input: t.object({
    q: t.string({ minLength: 1, description: "Search text" }),
    limit: t.optional(t.integer()),
    ratio: t.optional(t.number()),
    exact: t.optional(t.boolean()),
    tags: t.optional(t.array(t.string())),
    sizes: t.optional(t.array(t.integer())),
    mode: t.optional(t.union([t.literal("fast"), t.literal("full")])),
    filter: t.optional(t.object({ k: t.string() })),
  }),
  output: t.object({ echoed: t.looseObject({}) }),
  capability: "catalog.read",
  execute: (input) => {
    calls.push(input)
    return { echoed: input }
  },
})

const publish = defineTool({
  name: "publish",
  description: "Publish an entry.",
  input: t.object({ id: t.string() }),
  output: t.object({ published: t.boolean() }),
  capability: "catalog.write",
  approval: { kind: "required" },
  execute: () => ({ published: true }),
})

const escalate = defineTool({
  name: "escalate",
  description: "Escalate an entry.",
  input: t.object({ id: t.string() }),
  output: t.object({ level: t.integer() }),
  capability: "catalog.escalate",
  approval: { kind: "threshold", level: 2 },
  execute: () => ({ level: 2 }),
})

const failing = defineTool({
  name: "failing",
  description: "Always throws.",
  input: t.object({}),
  output: t.object({}),
  capability: "catalog.fail",
  execute: () => {
    throw new Error("disk at /var/secret full")
  },
})

const tools = [search, publish, escalate, failing]
const capabilities = tools.map((tool) => tool.capability)

async function run(
  argv: readonly string[],
  options: {
    stdin?: readonly (Uint8Array | string)[]
    call?: Omit<ToolCallOptions, "approval" | "dryRun" | "ledger">
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const captured = capture(options.stdin)
  const code = await runToolCli(tools, argv, {
    program: "acme",
    streams: captured.streams,
    capabilities,
    ...options.call,
  })
  return { code, stdout: captured.stdout(), stderr: captured.stderr() }
}

describe("runToolCli program usage", () => {
  test("no arguments prints usage to stderr and exits 2", async () => {
    const result = await run([])
    expect(result.code).toBe(TOOL_CLI_EXIT.usage)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Usage: acme <tool> [options]")
    expect(result.stderr).toContain("  search    Search the catalog.")
  })

  test("--help lists the tools on stdout", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await run([flag])
      expect(result.code).toBe(TOOL_CLI_EXIT.ok)
      expect(result.stdout).toContain("  publish   Publish an entry.")
      expect(result.stderr).toBe("")
    }
  })

  test("an unknown tool is a usage error naming it", async () => {
    const result = await run(["nope"])
    expect(result.code).toBe(TOOL_CLI_EXIT.usage)
    expect(result.stderr).toStartWith('acme: unknown tool "nope"')
  })

  test("refuses a duplicate tool name and an invalid input cap", async () => {
    const { streams } = capture()
    await expect(runToolCli([search, search], [], { program: "x", streams })).rejects.toThrow(
      "duplicate tool search",
    )
    for (const maxInputBytes of [0, 1.5]) {
      await expect(runToolCli(tools, [], { program: "x", streams, maxInputBytes })).rejects.toThrow(
        RangeError,
      )
    }
  })
})

describe("runToolCli tool usage", () => {
  test("--help describes each option from the input schema", async () => {
    const result = await run(["search", "--q", "x", "--help"])
    expect(result.code).toBe(TOOL_CLI_EXIT.ok)
    const help = result.stdout
    expect(help).toContain("Usage: acme search [options]")
    expect(help).toContain("Search the catalog.")
    expect(help).toMatch(/--q <string> +required; Search text/)
    expect(help).toMatch(/--exact \/ --no-exact/)
    expect(help).toMatch(/--tags <string> +repeatable/)
    expect(help).toMatch(/--filter <json>/)
    expect(help).toMatch(/--mode <string>/)
    expect(help).not.toContain("--yes")
  })

  test("maps JSON Schema unions, enums and type lists to flag kinds", async () => {
    const properties = {
      nullable: { type: ["string", "null"] },
      multi: { type: ["string", "number"] },
      level: { enum: [1, 2] },
      pick: { const: "only" },
      mixed: { enum: ["a", 1] },
      either: { oneOf: [{ type: "integer" }, { type: "integer" }] },
      empty: { anyOf: [] },
      input: { type: "string" },
    }
    const schemaTool = defineTool({
      name: "kinds",
      description: "Hand-written JSON Schema input.",
      input: {
        type: "object",
        properties,
        "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
      },
      output: t.object({}),
      execute: () => ({}),
    })
    const captured = capture()
    expect(
      await runToolCli([schemaTool], ["kinds", "--help"], {
        program: "acme",
        streams: captured.streams,
      }),
    ).toBe(TOOL_CLI_EXIT.ok)
    const help = captured.stdout()
    for (const spelling of [
      "--nullable <string>",
      "--multi <json>",
      "--level <number>",
      "--pick <string>",
      "--mixed <json>",
      "--either <integer>",
      "--empty <json>",
    ]) {
      expect(help).toContain(spelling)
    }
    expect(help).not.toContain("--input <string>")
  })

  test("approval options appear only for tools that need them", async () => {
    expect((await run(["publish", "--help"])).stdout).toContain("--yes")
    const threshold = (await run(["escalate", "-h"])).stdout
    expect(threshold).toContain("--approve-level <n>")
    expect(threshold).toContain("this tool needs 2")
  })
})

describe("runToolCli input", () => {
  test("coerces flags by property type and prints the output as JSON", async () => {
    calls.length = 0
    const result = await run([
      "search",
      "--q",
      "lamp",
      "--limit=5",
      "--ratio",
      "-0.5e1",
      "--exact",
      "--tags",
      "a",
      "--tags=b",
      "--sizes",
      "3",
      "--mode",
      "fast",
      "--filter",
      '{"k":"v"}',
    ])
    expect(result.code).toBe(TOOL_CLI_EXIT.ok)
    const expected = {
      q: "lamp",
      limit: 5,
      ratio: -5,
      exact: true,
      tags: ["a", "b"],
      sizes: [3],
      mode: "fast",
      filter: { k: "v" },
    }
    expect(calls).toEqual([expected])
    expect(JSON.parse(result.stdout)).toEqual({ echoed: expected })
    expect(result.stderr).toBe("")
  })

  test("--no-<flag> and --flag=false set a boolean false", async () => {
    calls.length = 0
    await run(["search", "--q", "a", "--no-exact"])
    await run(["search", "--q", "a", "--exact=false"])
    expect(calls).toEqual([
      { q: "a", exact: false },
      { q: "a", exact: false },
    ])
  })

  test("--input supplies the whole input and flags override its fields", async () => {
    calls.length = 0
    const result = await run(["search", "--input", '{"q":"old","limit":1}', "--q", "new"])
    expect(result.code).toBe(TOOL_CLI_EXIT.ok)
    expect(calls).toEqual([{ q: "new", limit: 1 }])
  })

  test("--input - reads JSON from stdin, split across chunks", async () => {
    calls.length = 0
    const bytes = new TextEncoder().encode('{"q":"café"}')
    const result = await run(["search", "--input", "-"], {
      stdin: [bytes.subarray(0, 9), bytes.subarray(9)],
    })
    expect(result.code).toBe(TOOL_CLI_EXIT.ok)
    expect(calls).toEqual([{ q: "café" }])
  })

  test("stdin input is capped, must be UTF-8, and needs a stdin", async () => {
    const captured = capture(["x".repeat(20)])
    const code = await runToolCli(tools, ["search", "--input", "-"], {
      program: "acme",
      streams: captured.streams,
      maxInputBytes: 10,
    })
    expect(code).toBe(TOOL_CLI_EXIT.usage)
    expect(captured.stderr()).toContain("--input exceeds 10 bytes")
    const invalid = await run(["search", "--input", "-"], { stdin: [new Uint8Array([0xff])] })
    expect(invalid.stderr).toContain("stdin is not UTF-8")
    const none = await run(["search", "--input", "-"])
    expect(none.stderr).toContain("--input - needs a readable stdin")
  })

  test("inline --input is capped too", async () => {
    const captured = capture()
    const code = await runToolCli(tools, ["search", `--input={"q":"${"x".repeat(20)}"}`], {
      program: "acme",
      streams: captured.streams,
      maxInputBytes: 10,
    })
    expect(code).toBe(TOOL_CLI_EXIT.usage)
    expect(captured.stderr()).toContain("--input exceeds 10 bytes")
  })

  test("a poisoned key in --input or a JSON flag is refused", async () => {
    const viaInput = await run(["search", "--input", '{"q":"a","__proto__":{"x":1}}'])
    expect(viaInput.code).toBe(TOOL_CLI_EXIT.usage)
    expect(viaInput.stderr).toContain("--input: expected JSON")
    const viaFlag = await run(["search", "--q", "a", "--filter", '{"__proto__":{"k":"v"}}'])
    expect(viaFlag.code).toBe(TOOL_CLI_EXIT.usage)
    expect(viaFlag.stderr).toContain("--filter: expected JSON")
  })

  test("a declared __proto__ property becomes an own field, not the prototype", async () => {
    let seen: unknown
    const odd = defineTool({
      name: "odd",
      description: "Takes a property named __proto__.",
      input: t.looseObject({}),
      output: t.object({}),
      execute: (input) => {
        seen = input
        return {}
      },
    })
    const captured = capture()
    const code = await runToolCli([odd], ["odd", "--input", '{"a":1}'], {
      program: "acme",
      streams: captured.streams,
      capabilities: [odd.capability],
      protoPoisoning: "ignore",
    })
    expect(code).toBe(TOOL_CLI_EXIT.ok)
    expect(Object.getPrototypeOf(seen)).toBe(Object.prototype)
  })

  test("usage errors name the problem and exit 2 without running the tool", async () => {
    calls.length = 0
    const cases: [readonly string[], string][] = [
      [["search", "lamp"], 'unexpected argument "lamp"'],
      [["search", "--"], 'unexpected argument "--"'],
      [["search", "--nope", "1"], "unknown option --nope"],
      [["search", "--q"], "--q needs a value"],
      [["search", "--q", "--dry-run"], "--q needs a value"],
      [["search", "--q", "a", "--q", "b"], "--q given twice"],
      [["search", "--q", "a", "--no-exact", "--no-exact"], "--exact given twice"],
      [["search", "--q", "a", "--limit", "1.5"], "--limit: expected an integer"],
      [
        ["search", "--q", "a", "--limit", "99999999999999999999"],
        "--limit: integer is out of the safe range",
      ],
      [["search", "--q", "a", "--ratio", "1e999"], "--ratio: number is not finite"],
      [["search", "--q", "a", "--ratio", "0x10"], "--ratio: expected a number"],
      [["search", "--q", "a", "--exact=yes"], "--exact: expected true or false"],
      [["search", "--q", "a", "--filter", "{"], "--filter: expected JSON"],
      [["search", "--dry-run=1"], "--dry-run takes no value"],
      [["search", "--input"], "--input needs a value"],
      [["search", "--input", "{}", "--input", "{}"], "--input given twice"],
      [["search", "--input", "[1]", "--q", "a"], "options need --input to be a JSON object"],
      [["search", "--approve-level", "0"], "--approve-level needs a positive integer"],
    ]
    for (const [argv, message] of cases) {
      const result = await run(argv)
      expect(result.code).toBe(TOOL_CLI_EXIT.usage)
      expect(result.stderr).toContain(`acme search: ${message}`)
      expect(result.stderr).toContain("Run `acme search --help` for its options.")
    }
    expect(calls).toEqual([])
  })

  test("input the schema rejects exits 2 with each issue", async () => {
    const result = await run(["search", "--q", ""])
    expect(result.code).toBe(TOOL_CLI_EXIT.usage)
    expect(result.stderr).toStartWith("acme search: input_invalid (input)")
    expect(result.stderr).toContain("  q: ")
    const whole = await run(["search", "--input", '"text"'])
    expect(whole.stderr).toContain("  input: ")
  })
})

describe("runToolCli admission", () => {
  test("a missing capability is refused with exit 3", async () => {
    const result = await run(["search", "--q", "a"], { call: { capabilities: [] } })
    expect(result.code).toBe(TOOL_CLI_EXIT.refused)
    expect(result.stderr).toStartWith("acme search: capability_denied (capability)")
  })

  test("approval comes only from --yes", async () => {
    const pending = await run(["publish", "--id", "1"])
    expect(pending.code).toBe(TOOL_CLI_EXIT.refused)
    expect(pending.stderr).toContain("approval_required (approval)")
    expect(pending.stderr).toContain("approve with --yes")
    const approved = await run(["publish", "--id", "1", "--yes"])
    expect(approved.code).toBe(TOOL_CLI_EXIT.ok)
    expect(JSON.parse(approved.stdout)).toEqual({ published: true })
  })

  test("a threshold approval needs --approve-level at or above the policy", async () => {
    const low = await run(["escalate", "--id", "1", "--yes"])
    expect(low.code).toBe(TOOL_CLI_EXIT.refused)
    expect(low.stderr).toContain("approve with --approve-level 2")
    const short = await run(["escalate", "--id", "1", "--approve-level", "1"])
    expect(short.stderr).toContain("approval_denied (approval)")
    const enough = await run(["escalate", "--id", "1", "--approve-level=2"])
    expect(enough.code).toBe(TOOL_CLI_EXIT.ok)
  })

  test("--dry-run admits without executing", async () => {
    calls.length = 0
    const result = await run(["search", "--q", "a", "--dry-run"])
    expect(result.code).toBe(TOOL_CLI_EXIT.ok)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("acme search: dry run admitted; nothing executed\n")
    expect(calls).toEqual([])
  })

  test("an execution failure exits 1 without the error's message", async () => {
    const result = await run(["failing"])
    expect(result.code).toBe(TOOL_CLI_EXIT.failed)
    expect(result.stderr).toBe("acme failing: execution_failed (execution)\n")
  })
})

describe("runToolCli --json", () => {
  test("prints the result envelope for success and failure", async () => {
    const ok = await run(["search", "--q", "a", "--json"])
    const okBody = JSON.parse(ok.stdout)
    expect(okBody.ok).toBe(true)
    expect(okBody.output).toEqual({ echoed: { q: "a" } })
    expect(okBody.dryRun).toBe(false)
    expect(Array.isArray(okBody.evidence)).toBe(true)
    expect(ok.stderr).toBe("")

    const refused = await run(["publish", "--id", "1", "--json"])
    expect(refused.code).toBe(TOOL_CLI_EXIT.refused)
    const refusedBody = JSON.parse(refused.stdout)
    expect(refusedBody.ok).toBe(false)
    expect(refusedBody.error).toEqual({ code: "approval_required", stage: "approval" })
    expect(refused.stderr).toBe("")
  })

  test("an output that cannot be serialized exits 1", async () => {
    const big = defineTool({
      name: "big",
      description: "Returns a BigInt.",
      input: t.object({}),
      output: {
        "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
      },
      execute: () => 1n,
    })
    for (const argv of [["big"], ["big", "--json"]]) {
      const captured = capture()
      const code = await runToolCli([big], argv, {
        program: "acme",
        streams: captured.streams,
        capabilities: [big.capability],
      })
      expect(code).toBe(TOOL_CLI_EXIT.failed)
      expect(captured.stderr()).toBe("acme big: the result is not JSON-serializable\n")
    }
  })
})

describe("runToolCli adapter conformance", () => {
  test("passes the shared tool-contract conformance checks", async () => {
    const result = await runToolContractConformance(
      {
        name: "cli",
        call: async (input, options = {}) => {
          const captured = capture()
          const argv = ["publish", "--input", JSON.stringify(input), "--json"]
          if (options.approval?.granted === true) argv.push("--yes")
          if (options.dryRun === true) argv.push("--dry-run")
          await runToolCli(tools, argv, {
            program: "acme",
            streams: captured.streams,
            capabilities: options.capabilities ?? [],
          })
          return JSON.parse(captured.stdout())
        },
      },
      {
        input: { id: "1" },
        capability: publish.capability,
        approval: { granted: true },
        dryRun: {},
      },
    )
    expect(result.checks).toEqual(["capability denial", "approval admission", "dry-run"])
  })
})

describe("runToolCli process streams", () => {
  test("uses process.stdout by default and refuses a runtime without streams", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process")
    const written: string[] = []
    const fake = {
      stdout: { write: (chunk: string) => written.push(chunk) },
      stderr: { write: (chunk: string) => written.push(chunk) },
      stdin: (async function* () {})(),
    }
    const withProcess = (value: unknown, argv: readonly string[]): Promise<number> => {
      Object.defineProperty(globalThis, "process", { value, configurable: true, writable: true })
      try {
        return runToolCli(tools, argv, { program: "acme" })
      } finally {
        if (descriptor !== undefined) Object.defineProperty(globalThis, "process", descriptor)
      }
    }
    expect(await withProcess(fake, ["--help"])).toBe(TOOL_CLI_EXIT.ok)
    expect(written.join("")).toContain("Usage: acme <tool> [options]")
    await expect(withProcess(undefined, ["--help"])).rejects.toThrow("no process streams")
  })
})
