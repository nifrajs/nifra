import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { SelfHealingController } from "../src/healing.ts"
import { IsolatedExtensionWorker } from "../src/isolated.ts"
import { UiExtensionHost } from "../src/ui.ts"

describe("self-healing and UI extension seams", () => {
  test("rolls back a failed staged repair", async () => {
    let rolledBack = 0
    const result = await new SelfHealingController({ maxAttempts: 1 }).repair({
      id: "tool-repair",
      reason: "tool failed",
      stage: () => ({ version: 2 }),
      verify: () => false,
      rollback: () => {
        rolledBack++
      },
    })
    expect(result.ok).toBe(false)
    expect(rolledBack).toBe(1)
  })

  test("activates verified repairs and rolls back unhealthy state", async () => {
    const events: string[] = []
    let rolledBack = 0
    const result = await new SelfHealingController({
      maxAttempts: 1,
      onEvent: (event) => {
        events.push(event.type)
      },
    }).repair({
      id: "health-repair",
      reason: "tool failed",
      stage: () => ({ version: 2 }),
      verify: () => true,
      activate: () => undefined,
      monitor: () => false,
      rollback: () => {
        rolledBack++
      },
    })
    expect(result.ok).toBe(false)
    expect(rolledBack).toBe(1)
    expect(events).toEqual([
      "repair.staged",
      "repair.verified",
      "repair.activated",
      "repair.unhealthy",
      "repair.rolled_back",
    ])
  })

  test("keeps the last known-good UI graph on a denied reload", () => {
    const host = new UiExtensionHost({ trustedCapabilities: [] })
    expect(
      host.reload([{ id: "panel", revision: "1", slot: "main", label: "Panel" }]).rolledBack,
    ).toBe(false)
    const result = host.reload([
      { id: "panel", revision: "2", slot: "main", label: "Panel", capabilities: ["network"] },
    ])
    expect(result.rolledBack).toBe(true)
    expect(host.extensions[0]?.revision).toBe("1")
  })

  test("previews a valid UI graph without activating it", () => {
    const host = new UiExtensionHost()
    const preview = host.preview([
      {
        id: "next",
        revision: "1",
        slot: "sidebar",
        label: "Next",
        theme: { name: "quiet", accent: "#79d7c1", density: "comfortable" },
        status: { text: "Preview", tone: "positive" },
      },
    ])
    expect(preview.rolledBack).toBe(false)
    expect(preview.revision).toBe("preview:0")
    expect(host.extensions).toEqual([])
    expect(host.reload(preview.active).rolledBack).toBe(false)
    expect(host.extensions[0]?.id).toBe("next")
    expect(host.extensions[0]?.theme?.name).toBe("quiet")
    expect(host.extensions[0]?.status?.tone).toBe("positive")
  })

  test("contains an extension worker and invokes a registered tool", async () => {
    const worker = new IsolatedExtensionWorker({
      modulePath: resolve(import.meta.dir, "fixtures/isolated-extension.ts"),
      cwd: process.cwd(),
    })
    try {
      expect((await worker.start()).tools.map((tool) => tool.name)).toEqual(["echo"])
      await expect(worker.invokeTool("echo", { ok: true })).resolves.toEqual({ ok: true })
    } finally {
      await worker.close()
    }
  })
})
