import { describe, expect, test } from "bun:test"
import { composeDescriptor } from "@nifrajs/agent/registry"
import {
  type CertifiableDescriptorAdapter,
  certifyAdapter,
  registryCertificationProfile,
} from "../src/index.ts"

const conformingAdapter: CertifiableDescriptorAdapter = {
  describe: () =>
    composeDescriptor({
      kind: "tool",
      name: "probe",
      inputSchema: { type: "object", properties: { a: { type: "string" } } },
    }),
  describeDrift: () =>
    composeDescriptor({
      kind: "tool",
      name: "probe",
      inputSchema: { type: "object", properties: { a: { type: "number" } } },
    }),
}

// Drift variant carries a DIFFERENT identity, which the drift check must reject.
const misidentifiedAdapter: CertifiableDescriptorAdapter = {
  describe: conformingAdapter.describe,
  describeDrift: () =>
    composeDescriptor({
      kind: "tool",
      name: "other",
      inputSchema: { type: "object", properties: { a: { type: "number" } } },
    }),
}

describe("registryCertificationProfile", () => {
  test("certifies a conforming descriptor adapter", async () => {
    const report = await certifyAdapter({
      profile: registryCertificationProfile(),
      adapterId: "conforming",
      createAdapter: () => conformingAdapter,
    })
    expect(report.ok).toBe(true)
    expect(report.evidenceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(report.capabilities.every((c) => c.status === "passed")).toBe(true)
  })

  test("fails an adapter whose drift variant changes identity", async () => {
    const report = await certifyAdapter({
      profile: registryCertificationProfile(),
      adapterId: "misidentified",
      createAdapter: () => misidentifiedAdapter,
    })
    expect(report.ok).toBe(false)
    const drift = report.checks.find((check) => check.id === "identity-drift")
    expect(drift?.ok).toBe(false)
  })
})
