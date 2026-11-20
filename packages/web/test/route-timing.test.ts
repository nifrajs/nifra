import { expect, test } from "bun:test"
import { guardChannel } from "../src/internal/output-guard.ts"
import { invokeLoader, type RoutePhase } from "../src/internal/route-timing.ts"

test("timing preserves synchronous values, thenables and failures from an unguarded loader", async () => {
  const phases: RoutePhase[] = []
  const record = (phase: RoutePhase) => phases.push(phase)
  expect(invokeLoader(() => 1, {}, record, "pageLoader")).toBe(1)
  const thenable = {
    // biome-ignore lint/suspicious/noThenProperty: Exercise a loader returning a non-native promise.
    then(resolve: (value: number) => void) {
      resolve(2)
    },
  }
  expect(await invokeLoader(() => thenable, {}, record, "layoutLoaders")).toBe(2)
  const error = new Error("loader failed")
  expect(() =>
    invokeLoader(
      () => {
        throw error
      },
      {},
      record,
      "pageLoader",
    ),
  ).toThrow(error)
  expect(phases).toEqual(["pageLoader", "layoutLoaders", "pageLoader"])
})

test("a guarded loader records validation on thrown responses and keeps the refusal", async () => {
  const phases: RoutePhase[] = []
  const record = (phase: RoutePhase) => phases.push(phase)
  const loader = guardChannel(
    async () => {
      throw new Response(null, { status: 200 })
    },
    { label: "test loader", guard: undefined, missing: "loaderOutput" },
    true,
  )
  let failure: unknown
  try {
    await invokeLoader(loader, {}, record, "pageLoader")
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).toContain("returned a 200 Response")
  expect(phases).toEqual(["pageLoader", "validation"])
})
