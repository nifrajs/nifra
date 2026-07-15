import { expect, test } from "bun:test"
import { cacheStoreCertificationProfile, certifyAdapter } from "@nifrajs/testing/certification"
import { MemoryCache } from "../src/index.ts"

test("MemoryCache satisfies the portable cache-store certification profile", async () => {
  const report = await certifyAdapter({
    profile: cacheStoreCertificationProfile(),
    adapterId: "nifra-memory-cache",
    createAdapter: () => new MemoryCache({ now: () => 0 }),
  })

  expect(report.ok).toBe(true)
  expect(report.capabilities.every((capability) => capability.status === "passed")).toBe(true)
})
