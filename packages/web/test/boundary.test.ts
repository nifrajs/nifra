import { describe, expect, test } from "bun:test"
import {
  type Boundary,
  type BoundaryRequestCtx,
  boundaryDescriptors,
  resolveDynamicBoundaries,
  startDynamicBoundaries,
} from "../src/boundary.ts"

const context = (): BoundaryRequestCtx => ({
  request: new Request("https://example.test/users/7"),
  params: { id: "7" },
  api: { label: "api" },
  env: { region: "test" },
  draft: false,
  search: { tab: "overview" },
  signal: new AbortController().signal,
})

describe("async boundaries", () => {
  test("describes modes without importing a UI framework", () => {
    const definitions: [Boundary<string, string>, Boundary<number, string>] = [
      { name: "feed", mode: "dynamic", load: async () => "ok", render: (data) => data },
      { name: "shell", mode: "static", render: (data) => String(data) },
    ]
    expect(boundaryDescriptors(definitions)).toEqual([
      { name: "feed", mode: "dynamic", hasLoad: true },
      { name: "shell", mode: "static", hasLoad: false },
    ])
  })

  test("runs dynamic boundaries concurrently and isolates contexts", async () => {
    let active = 0
    let peak = 0
    const seenParams: string[] = []
    const make = (name: string): Boundary<string, string> => ({
      name,
      mode: "dynamic",
      load: async (ctx) => {
        active++
        peak = Math.max(peak, active)
        seenParams.push(ctx.params.id ?? "")
        await Bun.sleep(2)
        active--
        return name
      },
      render: (data) => data,
    })
    const states = await resolveDynamicBoundaries([make("left"), make("right")], context())
    expect(peak).toBe(2)
    expect(seenParams).toEqual(["7", "7"])
    expect(states.left?.status).toBe("ready")
    expect(states.right?.status).toBe("ready")
  })

  test("contains one failure without rejecting siblings or exposing raw non-Error values", async () => {
    const states = await resolveDynamicBoundaries(
      [
        {
          name: "bad",
          mode: "dynamic",
          load: () => Promise.reject("secret payload"),
          render: (data: unknown) => data,
        },
        { name: "good", mode: "dynamic", load: async () => 7, render: (data) => data },
      ],
      context(),
    )
    expect(states.bad).toMatchObject({
      status: "error",
      error: { name: "Error", message: "Boundary failed" },
    })
    expect(states.bad?.error?.message).not.toContain("secret")
    expect(states.good).toMatchObject({ status: "ready", data: 7 })
  })

  test("publishes pending slots immediately and settles each slot independently", async () => {
    let releaseSlow!: (value: string) => void
    const slow = new Promise<string>((resolve) => {
      releaseSlow = resolve
    })
    const batch = startDynamicBoundaries(
      [
        { name: "slow", mode: "dynamic", load: () => slow, render: (data) => data },
        { name: "fast", mode: "dynamic", load: async () => "fast", render: (data) => data },
      ],
      context(),
    )
    expect(batch.initial.slow?.status).toBe("pending")
    expect(batch.initial.fast?.status).toBe("pending")
    await expect(batch.pending[1]?.promise).resolves.toBe("fast")
    releaseSlow("slow")
    await expect(batch.complete).resolves.toMatchObject({
      slow: { status: "ready", data: "slow" },
      fast: { status: "ready", data: "fast" },
    })
  })

  test("rejects duplicate names and unsafe intercept paths", () => {
    expect(() =>
      boundaryDescriptors([
        { name: "same", mode: "dynamic", render: () => null },
        { name: "same", mode: "dynamic", render: () => null },
      ]),
    ).toThrow(/duplicate boundary name/)
    expect(() =>
      boundaryDescriptors([
        { name: "modal", mode: { intercept: "//evil.test" }, render: () => null },
      ]),
    ).toThrow(/same-origin path/)
  })
})
