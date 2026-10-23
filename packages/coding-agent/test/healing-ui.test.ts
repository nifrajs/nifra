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

  test("rejects a manifest whose fields have the wrong type, as parsed JSON can", () => {
    const valid = { id: "panel", revision: "1", slot: "main", label: "Panel" }
    const malformed: readonly Record<string, unknown>[] = [
      { ...valid, id: ["panel"] },
      { ...valid, revision: ["1"] },
      { ...valid, slot: "not-a-slot" },
      { ...valid, label: { length: 3 } },
      { ...valid, label: ["Panel"] },
      { ...valid, capabilities: "network" },
      { ...valid, capabilities: [7] },
      { ...valid, theme: "plain" },
      { ...valid, theme: { name: "quiet", density: "loose" } },
      { ...valid, status: { text: ["a"] } },
      { ...valid, status: "ok" },
    ]
    const host = new UiExtensionHost()
    for (const manifest of malformed) {
      const result = host.reload(JSON.parse(JSON.stringify([manifest])))
      expect({ manifest, rolledBack: result.rolledBack }).toEqual({ manifest, rolledBack: true })
    }
    expect(host.reload(JSON.parse('"panel"')).rolledBack).toBe(true)
    expect(host.extensions).toEqual([])
  })

  test("keeps only the known manifest fields", () => {
    const host = new UiExtensionHost()
    const manifest = {
      id: "panel",
      revision: "1",
      slot: "main",
      label: "Panel",
      html: "<script>",
      theme: { name: "quiet", css: "x" },
      status: { text: "ok", onClick: "x" },
    }
    expect(host.reload(JSON.parse(JSON.stringify([manifest]))).rolledBack).toBe(false)
    expect(host.extensions).toEqual([
      {
        id: "panel",
        revision: "1",
        slot: "main",
        label: "Panel",
        capabilities: [],
        theme: { name: "quiet" },
        status: { text: "ok" },
      },
    ])
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

  test("a worker that exits cleanly before it is ready fails start", async () => {
    const worker = new IsolatedExtensionWorker({
      modulePath: resolve(import.meta.dir, "fixtures/isolated-exit-extension.ts"),
      cwd: process.cwd(),
    })
    try {
      await expect(worker.start()).rejects.toThrow("isolated extension worker exited with code 0")
      await expect(worker.invokeTool("echo", {})).rejects.toThrow("exited with code 0")
    } finally {
      await worker.close()
    }
  })

  test("a worker that never becomes ready fails start at its deadline and is stopped", async () => {
    const worker = new IsolatedExtensionWorker({
      modulePath: resolve(import.meta.dir, "fixtures/isolated-stalled-extension.ts"),
      cwd: process.cwd(),
      startTimeoutMs: 200,
    })
    try {
      await expect(worker.start()).rejects.toThrow("worker was not ready within 200ms")
      expect(await Reflect.get(worker, "process")?.exited).not.toBe(0)
    } finally {
      await worker.close()
    }
  })

  test("startTimeoutMs is range-checked like timeoutMs", () => {
    expect(
      () =>
        new IsolatedExtensionWorker({
          modulePath: resolve(import.meta.dir, "fixtures/isolated-extension.ts"),
          cwd: process.cwd(),
          startTimeoutMs: 0,
        }),
    ).toThrow("startTimeoutMs is invalid")
  })

  test("preserves a worker stack only in local diagnostics mode", async () => {
    const defaultWorker = new IsolatedExtensionWorker({
      modulePath: resolve(import.meta.dir, "fixtures/isolated-error-extension.ts"),
      cwd: process.cwd(),
    })
    try {
      await defaultWorker.start()
      let error: unknown
      try {
        await defaultWorker.invokeTool("fail", {})
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("extension diagnostic")
      expect((error as Error).stack).not.toContain("isolated-error-extension.ts")
    } finally {
      await defaultWorker.close()
    }

    const worker = new IsolatedExtensionWorker({
      modulePath: resolve(import.meta.dir, "fixtures/isolated-error-extension.ts"),
      cwd: process.cwd(),
      exposeErrorStacks: true,
    })
    try {
      await worker.start()
      try {
        await worker.invokeTool("fail", {})
        throw new Error("expected isolated tool failure")
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe("extension diagnostic")
        expect((error as Error).stack).toContain("isolated-error-extension.ts")
      }
    } finally {
      await worker.close()
    }
  })
})

describe("self-healing controller bounds", () => {
  const proposal = {
    id: "tool-repair",
    reason: "tool failed",
    stage: () => ({ version: 2 }),
    verify: () => true,
    rollback: () => undefined,
  }

  test("maxAttempts must be between 1 and 8", () => {
    expect(() => new SelfHealingController({ maxAttempts: 0 })).toThrow(
      "healing: maxAttempts must be between 1 and 8",
    )
  })

  test("refuses a malformed id and an untrusted capability before staging", async () => {
    const events: unknown[] = []
    const controller = new SelfHealingController({ onEvent: (event) => void events.push(event) })
    expect(await controller.repair({ ...proposal, id: "Not An Id" })).toEqual({
      ok: false,
      attempts: 0,
      error: "invalid repair id",
    })
    expect(await controller.repair({ ...proposal, capabilities: ["network"] })).toEqual({
      ok: false,
      attempts: 0,
      error: "untrusted capability: network",
    })
    expect(events).toEqual([{ type: "repair.denied", id: "tool-repair", capability: "network" }])
  })

  test("a verified repair succeeds on its first attempt", async () => {
    expect(
      await new SelfHealingController({ trustedCapabilities: ["write"] }).repair({
        ...proposal,
        capabilities: ["write"],
        monitor: () => true,
      }),
    ).toEqual({ ok: true, attempts: 1 })
  })

  test("a rollback that fails is reported with the repair's error", async () => {
    const result = await new SelfHealingController({ maxAttempts: 1 }).repair({
      ...proposal,
      verify: () => false,
      rollback: () => {
        throw new Error("disk full")
      },
    })
    expect(result).toEqual({
      ok: false,
      attempts: 1,
      error: "repair verification failed; rollback failed: disk full",
    })
  })
})
