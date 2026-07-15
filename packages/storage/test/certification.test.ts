import { expect, test } from "bun:test"
import { certifyAdapter, storageAdapterCertificationProfile } from "@nifrajs/testing/certification"
import { MemoryStorage } from "../src/index.ts"

test("MemoryStorage satisfies the portable storage-adapter certification profile", async () => {
  const report = await certifyAdapter({
    profile: storageAdapterCertificationProfile(),
    adapterId: "nifra-memory-storage",
    createAdapter: () => new MemoryStorage(),
  })

  expect(report.ok).toBe(true)
  expect(report.capabilities.every((capability) => capability.status === "passed")).toBe(true)
})
