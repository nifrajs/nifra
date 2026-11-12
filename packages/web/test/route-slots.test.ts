import { describe, expect, test } from "bun:test"
import {
  hasRouteSlotsSearch,
  MAX_ROUTE_SLOTS,
  normalizeRouteSlotRegistry,
  normalizeRouteSlotTarget,
  parseRouteSlots,
  ROUTE_SLOT_QUERY_PREFIX,
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
  test("serializes flat bounded state and preserves unrelated URL state", () => {
    const first = withRouteSlots("/dashboard?tab=overview#summary", {
      inspector: "/users/7?tab=activity",
      activity: "/activity",
    })
    expect(first).toBe(
      "/dashboard?tab=overview&slot.activity=%2Factivity&slot.inspector=%2Fusers%2F7%3Ftab%3Dactivity#summary",
    )
    expect(parseRouteSlots(first)).toEqual({
      activity: "/activity",
      inspector: "/users/7?tab=activity",
    })

    const changed = setRouteSlot(first, "inspector", "/users/8")
    expect(parseRouteSlots(changed)).toEqual({ activity: "/activity", inspector: "/users/8" })
    expect(changed).toBe(
      "/dashboard?tab=overview&slot.activity=%2Factivity&slot.inspector=%2Fusers%2F8#summary",
    )
    expect(changed.endsWith("#summary")).toBe(true)

    const closed = setRouteSlot(changed, "activity", null)
    expect(parseRouteSlots(closed)).toEqual({ inspector: "/users/8" })
  })

  test("rejects malformed, duplicate, invalid-name, and oversized state", () => {
    expect(errorCode(() => parseRouteSlots("/dashboard?slot.=x"))).toBe("malformed")
    expect(
      errorCode(() =>
        parseRouteSlots("/dashboard?slot.inspector=%2Fusers%2F7&slot.inspector=%2Fusers%2F8"),
      ),
    ).toBe("malformed")
    expect(errorCode(() => parseRouteSlots("/dashboard?slot.inspector=not-a-path"))).toBe(
      "invalid_target",
    )

    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_ROUTE_SLOTS + 1 }, (_, index) => [`slot${index}`, "/target"]),
    )
    expect(errorCode(() => withRouteSlots("/dashboard", tooMany))).toBe("too_large")
    expect(errorCode(() => parseRouteSlots(`/dashboard?slot.side=${"x".repeat(1100)}`))).toBe(
      "too_large",
    )
  })

  test("rejects oversized slot names even when the reserved prefix is percent-encoded", () => {
    const oversizedName = "a".repeat(200)
    const encodedPrefix = "%73%6c%6f%74%2e"
    expect(() =>
      parseRouteSlots(`/dashboard?${encodedPrefix}${oversizedName}=%2Fusers%2F7`),
    ).toThrow()
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
      "/users/1?slot.side=%2Fadmin",
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

test("slot edits preserve unrelated query bytes and no-op writes do not rewrite", () => {
  for (const query of ["q=a%20b", "tag[]=1", "a=b;c", "x=~", "x='"]) {
    const path = `/reports?${query}`
    const changed = withRouteSlots(path, { side: "/users/1" })
    expect(stripRouteSlots(changed)).toBe(path)
    expect(withRouteSlots(path, {})).toBe(path)
  }
  expect(hasRouteSlotsSearch("q=a%20b&slot%2Eside=%2Fusers%2F1")).toBe(true)
  expect(hasRouteSlotsSearch("q=slot.side%3D%2Fusers%2F1")).toBe(false)
  expect(stripRouteSlots("//evil.example/x")).toBe("//evil.example/x")
  expect(stripRouteSlots("/\\evil.example/y")).toBe("/\\evil.example/y")
  const encodedName = ROUTE_SLOT_QUERY_PREFIX.replaceAll(".", "%2e") + "side"
  expect(stripRouteSlots(`/reports?keep=%2f&${encodedName}=x&next=2#panel`)).toBe(
    "/reports?keep=%2f&next=2#panel",
  )
})
