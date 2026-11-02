import { expect, test } from "bun:test"
import { markTrustedBodyFraming } from "../src/server/body.ts"
import "../src/server/body-lane.ts"

test("Deno framed text parses BOM safely and keeps read and continuation failures separate", async () => {
  // The real Deno adapter is covered by its server tests; this isolated import also exercises the
  // Deno-selected reader in Bun's per-file coverage run without changing the loaded normal lane.
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Deno")
  Object.defineProperty(globalThis, "Deno", { configurable: true, value: {} })
  let lane: typeof import("../src/server/body-lane.ts")
  try {
    const isolatedPath = "../src/server/body-lane.ts?deno-text-coverage"
    lane = await import(isolatedPath)
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "Deno")
    else Object.defineProperty(globalThis, "Deno", previous)
  }
  const request = (body: string) => {
    const bytes = new TextEncoder().encode(body)
    const value = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-length": String(bytes.byteLength) },
      body: bytes,
    })
    markTrustedBodyFraming(value)
    return value
  }
  expect(await lane.readBoundedJsonSource(request('\ufeff{"name":"Ada"}'), 100)).toEqual({
    name: "Ada",
  })
  expect(await lane.readBoundedJsonSource(request("{"), 100)).toMatchObject({
    plain: { status: 400 },
  })
  const unreadable = request("{}")
  unreadable.text = () => Promise.reject(new Error("failed read"))
  expect(await lane.readBoundedJsonSource(unreadable, 100)).toMatchObject({
    plain: { status: 400 },
  })
  const error = new Error("handler failed")
  await expect(
    lane.readBoundedJsonSource(
      request("{}"),
      100,
      "reject",
      () => {
        throw error
      },
      () => undefined,
    ),
  ).rejects.toBe(error)
})
