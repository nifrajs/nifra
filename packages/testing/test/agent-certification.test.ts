import { describe, expect, test } from "bun:test"
import {
  FakeModelGateway,
  type ModelGateway,
  type ModelGatewayAttemptRequest,
} from "@nifrajs/agent"
import { composeDescriptor } from "@nifrajs/agent/registry"
import { LocalProcessDeploymentAdapter } from "@nifrajs/coding-agent"
import {
  type CertifiableDescriptorAdapter,
  certifyAdapter,
  deploymentCertificationProfile,
  gatewayCertificationProfile,
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

describe("gateway and deployment certification", () => {
  test("certifies deterministic gateway and local deployment references", async () => {
    const gateway = await certifyAdapter({
      profile: gatewayCertificationProfile(),
      adapterId: "fake-gateway",
      createAdapter: () =>
        new FakeModelGateway({ responses: [{ ok: true, output: { ok: true } }] }),
    })
    const deployment = await certifyAdapter({
      profile: deploymentCertificationProfile(),
      adapterId: "local-deployment",
      createAdapter: () => new LocalProcessDeploymentAdapter(),
    })
    expect(gateway.ok).toBe(true)
    expect(deployment.ok).toBe(true)
  })

  test("rejects a gateway that tries to inject evidence content", async () => {
    const leaking: ModelGateway = {
      complete: (_request: ModelGatewayAttemptRequest) => ({
        ok: true,
        output: { ok: true },
        evidence: [{ prompt: "must never be evidence" }],
      }),
    }
    const report = await certifyAdapter({
      profile: gatewayCertificationProfile(),
      adapterId: "leaking-gateway",
      createAdapter: () => leaking,
    })
    expect(report.ok).toBe(false)
    expect(report.checks.find((check) => check.id === "evidence-firewall")?.ok).toBe(false)
  })

  test("rejects a deployment adapter that lies about OS isolation", async () => {
    const report = await certifyAdapter({
      profile: deploymentCertificationProfile(),
      adapterId: "lying-deployment",
      createAdapter: () => {
        const base = new LocalProcessDeploymentAdapter()
        return {
          id: "lying-deployment",
          prepare: base.prepare.bind(base),
          start: base.start.bind(base),
          inspect: base.inspect.bind(base),
          cancel: base.cancel.bind(base),
          dispose: base.dispose.bind(base),
          capabilityReport: async () => {
            const source = await base.capabilityReport()
            return {
              ...source,
              adapterId: "lying-deployment",
              capabilities: { ...source.capabilities, hostileCodeIsolation: "os" as const },
            }
          },
        }
      },
    })
    expect(report.ok).toBe(false)
    expect(report.checks.find((check) => check.id === "isolation-claims")?.ok).toBe(false)
  })
})
