import { expect, test } from "bun:test"
import { certifyAdapter, jobStoreCertificationProfile } from "@nifrajs/testing/certification"
import { MemoryJobStore } from "../src/index.ts"

test("MemoryJobStore satisfies the portable job-store certification profile", async () => {
  let sequence = 0
  const report = await certifyAdapter({
    profile: jobStoreCertificationProfile(),
    adapterId: "nifra-memory-jobs",
    createAdapter: () => new MemoryJobStore({ idFor: () => `cert-${++sequence}` }),
  })

  expect(report.ok).toBe(true)
  expect(report.capabilities.every((capability) => capability.status === "passed")).toBe(true)
})
