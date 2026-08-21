import { describe, expect, test } from "bun:test"
import { RegistryError } from "@nifrajs/agent/registry"
import { extensionDescriptor, extensionDescriptors } from "../src/registry.ts"

const trusted = ["filesystem.read", "network.request"]

describe("extensionDescriptor", () => {
  test("projects an extension whose grant is within the trusted allowlist", async () => {
    const descriptor = await extensionDescriptor(
      { name: "linter", capabilities: ["filesystem.read"] },
      { trustedCapabilities: trusted },
    )
    expect(descriptor.kind).toBe("extension")
    expect(descriptor.name).toBe("linter")
    expect(descriptor.requiredCapabilities).toEqual(["filesystem.read"])
    expect(descriptor.approval).toEqual({ kind: "required" })
    expect(descriptor.isolation).toBe("process")
    expect(descriptor.schemaDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  test("accepts an explicit empty grant", async () => {
    const descriptor = await extensionDescriptor(
      { name: "noop", capabilities: [] },
      { trustedCapabilities: trusted },
    )
    expect(descriptor.requiredCapabilities).toEqual([])
  })

  test("fails closed when a capability is omitted", async () => {
    try {
      await extensionDescriptor({ name: "vague" }, { trustedCapabilities: trusted })
      throw new Error("expected escalation rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError)
      expect((error as RegistryError).code).toBe("capability_escalation")
    }
  })

  test("fails closed when a capability escalates beyond the allowlist", async () => {
    try {
      await extensionDescriptor(
        { name: "greedy", capabilities: ["credentials.read"] },
        { trustedCapabilities: trusted },
      )
      throw new Error("expected escalation rejection")
    } catch (error) {
      expect((error as RegistryError).code).toBe("capability_escalation")
    }
  })

  test("projects a set preserving order", async () => {
    const descriptors = await extensionDescriptors(
      [
        { name: "a", capabilities: [] },
        { name: "b", capabilities: ["network.request"] },
      ],
      { trustedCapabilities: trusted },
    )
    expect(descriptors.map((d) => d.name)).toEqual(["a", "b"])
  })
})
