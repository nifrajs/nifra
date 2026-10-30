import { describe, expect, test } from "bun:test"
import {
  MAX_ROUTE_SLOTS,
  normalizeRouteSlotRegistry,
  normalizeRouteSlotTarget,
  parseRouteSlots,
  ROUTE_SLOTS_PARAM,
  RouteSlotStateError,
  setRouteSlot,
  stripRouteSlots,
  withRouteSlots,
} from "../src/route-slots.ts"

const errorCode = (work: () => unknown): string => {
  try {
    work()
  } catch (error) {
    if (error instanceof RouteSlotStateError) return error.code
    throw error
  }
  throw new Error("expected RouteSlotStateError")
}

describe("route-slot URL state", () => {
  test("serializes canonical bounded state and preserves unrelated URL state", () => {
    const first = withRouteSlots("/dashboard?tab=overview#summary", {
      inspector: "/users/7?tab=activity",
      activity: "/activity",
    })
    expect(parseRouteSlots(first)).toEqual({
      activity: "/activity",
      inspector: "/users/7?tab=activity",
    })

    const changed = setRouteSlot(first, "inspector", "/users/8")
    expect(parseRouteSlots(changed)).toEqual({ activity: "/activity", inspector: "/users/8" })
    expect(changed).toContain("tab=overview")
    expect(changed.endsWith("#summary")).toBe(true)

    const closed = setRouteSlot(changed, "activity", null)
    expect(parseRouteSlots(closed)).toEqual({ inspector: "/users/8" })
  })

  test("rejects malformed, duplicate, noncanonical, and oversized state", () => {
    expect(errorCode(() => parseRouteSlots(`/dashboard?${ROUTE_SLOTS_PARAM}=not-json`))).toBe(
      "malformed",
    )

    const duplicate = new URL("/dashboard", "https://nifra.invalid")
    duplicate.searchParams.append(ROUTE_SLOTS_PARAM, '{"v":1,"slots":{}}')
    duplicate.searchParams.append(ROUTE_SLOTS_PARAM, '{"v":1,"slots":{}}')
    expect(errorCode(() => parseRouteSlots(duplicate.pathname + duplicate.search))).toBe(
      "malformed",
    )

    const reordered = new URL("/dashboard", "https://nifra.invalid")
    reordered.searchParams.set(ROUTE_SLOTS_PARAM, '{"v":1,"slots":{"z":"/z","a":"/a"}}')
    expect(errorCode(() => parseRouteSlots(reordered.pathname + reordered.search))).toBe(
      "malformed",
    )

    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_ROUTE_SLOTS + 1 }, (_, index) => [`slot${index}`, "/target"]),
    )
    expect(errorCode(() => withRouteSlots("/dashboard", tooMany))).toBe("too_large")
  })

  test("rejects cross-origin, traversal, separator, fragment, and nested-slot targets", () => {
    for (const target of [
      "//evil.example/users/1",
      "https://evil.example/users/1",
      "/users/../admin",
      "/%2e%2e/admin",
      "/users/%2Fadmin",
      "/users/%5cadmin",
      "/users/1#details",
      "/users/1?__nifra_slots=%7B%22v%22%3A1%2C%22slots%22%3A%7B%7D%7D",
      "/users/%ZZ",
    ]) {
      expect(errorCode(() => normalizeRouteSlotTarget(target))).toBe("invalid_target")
    }
  })

  test("validates route-module declarations against known route identities", () => {
    const known = new Set(["/dashboard", "/users/:id", "/activity"])
    expect(
      normalizeRouteSlotRegistry({ inspector: ["/users/:id"], activity: ["/activity"] }, known),
    ).toEqual({ inspector: ["/users/:id"], activity: ["/activity"] })

    expect(errorCode(() => normalizeRouteSlotRegistry({ inspector: ["/missing"] }, known))).toBe(
      "unknown_route",
    )
    expect(errorCode(() => normalizeRouteSlotRegistry({ Bad: ["/users/:id"] }, known))).toBe(
      "malformed",
    )
  })
})

test("stores inherited object names as own route-slot entries", () => {
  const registry = normalizeRouteSlotRegistry(
    { constructor: ["/users/:id"] },
    new Set(["/users/:id"]),
  )
  expect(Object.getPrototypeOf(registry)).toBeNull()
  expect(Object.hasOwn(registry, "constructor")).toBe(true)
  expect(Object.getOwnPropertyDescriptor(registry, "constructor")?.value).toEqual(["/users/:id"])
})

test("strips route-slot state without rewriting path bytes or other query text", () => {
  expect(stripRouteSlots("//evil.example/x")).toBe("//evil.example/x")
  expect(stripRouteSlots("/\\evil.example/y")).toBe("/\\evil.example/y")
  const encodedName = ROUTE_SLOTS_PARAM.replaceAll("_", "%5f")
  expect(stripRouteSlots(`/reports?keep=%2f&${encodedName}=x&next=2#panel`)).toBe(
    "/reports?keep=%2f&next=2#panel",
  )
})
