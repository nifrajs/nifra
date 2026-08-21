import { describe, expect, test } from "bun:test"
import { defineTool } from "@nifrajs/core/tool-contract"
import { t } from "@nifrajs/schema"
import {
  type CapabilityDescriptor,
  composeDescriptor,
  composeRegistrySnapshot,
  descriptorFromTool,
  parseCapabilityDescriptor,
  RegistryError,
} from "../src/registry.ts"

const DIGEST = "a".repeat(64)

function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    descriptorVersion: 1,
    kind: "tool",
    name: "read-file",
    version: "1.2.3",
    schemaDigest: DIGEST,
    requiredCapabilities: ["filesystem.read"],
    approval: { kind: "none" },
    retry: "none",
    idempotency: "none",
    isolation: "inherit",
    ...overrides,
  }
}

function sampleTool() {
  return defineTool({
    name: "read-file",
    description: "reads a file",
    input: t.object({ path: t.string() }),
    output: t.object({ text: t.string() }),
    capability: "filesystem.read",
    approval: { kind: "required" },
    idempotency: { scope: "request", key: (input: { path: string }) => input.path },
    execute: async () => ({ text: "" }),
  })
}

async function otherDescriptor(name: string): Promise<CapabilityDescriptor> {
  return composeDescriptor({
    kind: "tool",
    name,
    inputSchema: { type: "object", properties: { a: { type: "string" } } },
  })
}

describe("parseCapabilityDescriptor", () => {
  test("accepts a well-formed descriptor and freezes it", () => {
    const descriptor = parseCapabilityDescriptor(validRaw())
    expect(descriptor.name).toBe("read-file")
    expect(Object.isFrozen(descriptor)).toBe(true)
  })

  test("rejects an absent version with missing_version", () => {
    const raw = validRaw()
    delete raw.version
    expect(() => parseCapabilityDescriptor(raw)).toThrow(RegistryError)
    try {
      parseCapabilityDescriptor(raw)
    } catch (error) {
      expect((error as RegistryError).code).toBe("missing_version")
    }
  })

  test("rejects an unknown kind with unsupported_kind", () => {
    try {
      parseCapabilityDescriptor(validRaw({ kind: "workflow" }))
    } catch (error) {
      expect((error as RegistryError).code).toBe("unsupported_kind")
    }
  })

  test("rejects a content-bearing field with content_field", () => {
    for (const key of ["description", "input", "output", "prompt", "payload"]) {
      try {
        parseCapabilityDescriptor(validRaw({ [key]: "leak" }))
        throw new Error(`expected rejection for ${key}`)
      } catch (error) {
        expect((error as RegistryError).code).toBe("content_field")
      }
    }
  })

  test("rejects an unknown structural field with invalid_descriptor", () => {
    try {
      parseCapabilityDescriptor(validRaw({ extra: 1 }))
    } catch (error) {
      expect((error as RegistryError).code).toBe("invalid_descriptor")
    }
  })

  test("rejects a malformed schema digest", () => {
    try {
      parseCapabilityDescriptor(validRaw({ schemaDigest: "not-hex" }))
    } catch (error) {
      expect((error as RegistryError).code).toBe("invalid_schema_digest")
    }
  })

  test("normalizes required capabilities to a sorted, deduped set", () => {
    const descriptor = parseCapabilityDescriptor(
      validRaw({ requiredCapabilities: ["b", "a", "b"] }),
    )
    expect(descriptor.requiredCapabilities).toEqual(["a", "b"])
  })

  test("carries an integer approval threshold", () => {
    const descriptor = parseCapabilityDescriptor(
      validRaw({ approval: { kind: "threshold", level: 2 } }),
    )
    expect(descriptor.approval).toEqual({ kind: "threshold", level: 2 })
  })
})

describe("descriptorFromTool", () => {
  test("projects a core tool without exposing content", async () => {
    const descriptor = await descriptorFromTool(sampleTool())
    expect(descriptor.kind).toBe("tool")
    expect(descriptor.name).toBe("read-file")
    expect(descriptor.requiredCapabilities).toEqual(["filesystem.read"])
    expect(descriptor.approval).toEqual({ kind: "required" })
    expect(descriptor.retry).toBe("idempotent")
    expect(descriptor.idempotency).toBe("request")
    expect(descriptor.schemaDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(descriptor)).not.toContain("reads a file")
  })

  test("shares identity and digest across tool and mcp-tool kinds", async () => {
    const tool = sampleTool()
    const asTool = await descriptorFromTool(tool, { kind: "tool" })
    const asMcp = await descriptorFromTool(tool, { kind: "mcp-tool" })
    expect(asMcp.kind).toBe("mcp-tool")
    expect(asMcp.name).toBe(asTool.name)
    expect(asMcp.schemaDigest).toBe(asTool.schemaDigest)
    expect(asMcp.requiredCapabilities).toEqual(asTool.requiredCapabilities)
  })
})

describe("composeRegistrySnapshot", () => {
  test("digest is independent of input order", async () => {
    const a = await otherDescriptor("alpha")
    const b = await otherDescriptor("beta")
    const forward = await composeRegistrySnapshot([a, b])
    const reverse = await composeRegistrySnapshot([b, a])
    expect(forward.digest).toBe(reverse.digest)
    expect(forward.descriptors.map((d) => d.name)).toEqual(["alpha", "beta"])
  })

  test("duplicate identity with equal schema fails descriptor_collision", async () => {
    const a = await otherDescriptor("alpha")
    try {
      await composeRegistrySnapshot([a, a])
    } catch (error) {
      expect((error as RegistryError).code).toBe("descriptor_collision")
    }
  })

  test("same identity with drifted schema fails schema_drift", async () => {
    const a = await composeDescriptor({
      kind: "tool",
      name: "alpha",
      inputSchema: { type: "object", properties: { a: { type: "string" } } },
    })
    const drifted = await composeDescriptor({
      kind: "tool",
      name: "alpha",
      inputSchema: { type: "object", properties: { a: { type: "number" } } },
    })
    expect(a.schemaDigest).not.toBe(drifted.schemaDigest)
    try {
      await composeRegistrySnapshot([a, drifted])
    } catch (error) {
      expect((error as RegistryError).code).toBe("schema_drift")
    }
  })
})
