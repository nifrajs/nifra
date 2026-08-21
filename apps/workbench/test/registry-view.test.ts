/**
 * Replay fixtures for the Workbench capability registry (UX-05). The registry panel fetches
 * descriptors through the bounded `command` escape hatch and projects each with
 * `toRegistryCapabilityView`, exactly as `refreshRegistry` in the browser bundle does. These tests
 * drive that path against a scripted transport and assert the projection is content-free and that the
 * panel degrades cleanly when no registry is offered.
 */

import { describe, expect, test } from "bun:test"
import {
  AgentAppClient,
  type AgentTransport,
  type AgentTransportRequest,
  type CommandOutcome,
  type RegistryCapabilityView,
  toRegistryCapabilityView,
} from "@nifrajs/agent-app"

const DIGEST = "b".repeat(64)

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    descriptorVersion: 1,
    kind: "tool",
    name: "read-file",
    version: "1.0.0",
    schemaDigest: DIGEST,
    requiredCapabilities: ["filesystem"],
    approval: { kind: "required" },
    retry: "none",
    idempotency: "request",
    isolation: "process",
    ...overrides,
  }
}

const DESCRIPTORS: unknown[] = [
  descriptor({ name: "read-file" }),
  descriptor({ name: "run-tests", kind: "tool", approval: { kind: "threshold", level: 2 } }),
  descriptor({ name: "deploy", kind: "deployment-adapter", isolation: "sandbox" }),
  // Content-bearing descriptor: the projection must keep the identity and drop the content.
  descriptor({ name: "leaky", inputSchema: { secret: true }, description: "leak", prompt: "leak" }),
  // Malformed: unknown kind. Must be dropped from the projected list.
  descriptor({ name: "junk", kind: "provider" }),
]

class FakeTransport implements AgentTransport {
  constructor(private readonly offerRegistry: boolean) {}

  async command<T>(request: AgentTransportRequest): Promise<CommandOutcome<T>> {
    const ok = (value: unknown): CommandOutcome<T> => ({ ok: true, status: 200, value: value as T })
    switch (request.method) {
      case "session.create":
        return ok({
          id: "s1",
          backend: "replay",
          status: "ready",
          createdAt: 1,
          updatedAt: 1,
          lastSeq: -1,
          capabilities: [],
        })
      case "registry.list":
        return this.offerRegistry
          ? ok({ descriptors: DESCRIPTORS })
          : { ok: false, status: 404, error: "not found" }
      default:
        return { ok: false, status: 404, error: "not found" }
    }
  }

  stream(_request: AgentTransportRequest): AsyncIterable<never> {
    return {
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    }
  }
}

/** Mirror of the browser panel's projection step: fetch, then map through the content-free view. */
async function loadRegistry(client: AgentAppClient): Promise<RegistryCapabilityView[]> {
  const outcome = await client.command<Record<string, unknown>>("registry.list")
  if (!outcome.ok) return []
  const raw = outcome.value.descriptors
  const source = Array.isArray(raw) ? raw : []
  const views: RegistryCapabilityView[] = []
  for (const item of source) {
    const view = toRegistryCapabilityView(item)
    if (view !== undefined) views.push(view)
  }
  return views
}

async function connect(offerRegistry: boolean): Promise<AgentAppClient> {
  const client = new AgentAppClient(new FakeTransport(offerRegistry))
  await client.createSession()
  return client
}

describe("workbench capability registry", () => {
  test("projects descriptors to content-free cards and drops malformed entries", async () => {
    const views = await loadRegistry(await connect(true))
    expect(views.map((view) => view.name)).toEqual(["read-file", "run-tests", "deploy", "leaky"])
    const deploy = views.find((view) => view.name === "deploy")
    expect(deploy).toMatchObject({ kind: "deployment-adapter", isolation: "sandbox" })
  })

  test("keeps the identity of a content-bearing descriptor but surfaces none of its content", async () => {
    const views = await loadRegistry(await connect(true))
    const leaky = views.find((view) => view.name === "leaky")
    expect(leaky).not.toBeUndefined()
    expect(leaky).not.toHaveProperty("inputSchema")
    expect(leaky).not.toHaveProperty("description")
    expect(leaky).not.toHaveProperty("prompt")
  })

  test("carries a threshold approval as a bounded level", async () => {
    const views = await loadRegistry(await connect(true))
    const runTests = views.find((view) => view.name === "run-tests")
    expect(runTests?.approval).toBe("threshold")
    expect(runTests?.approvalLevel).toBe(2)
  })

  test("stays usable when the host offers no registry", async () => {
    const views = await loadRegistry(await connect(false))
    expect(views).toEqual([])
  })
})
