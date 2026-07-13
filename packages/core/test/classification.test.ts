import { describe, expect, test } from "bun:test"
import {
  classificationAtLeast,
  DATA_CLASSIFICATION_RANK,
  evaluateCapabilityAssurance,
  isDataClassification,
  maxClassification,
  reflectRoutes,
  server,
  snapshotCapabilities,
} from "../src/index.ts"

describe("data-classification helpers", () => {
  test("rank orders public < pii < secret", () => {
    expect(DATA_CLASSIFICATION_RANK.public).toBeLessThan(DATA_CLASSIFICATION_RANK.pii)
    expect(DATA_CLASSIFICATION_RANK.pii).toBeLessThan(DATA_CLASSIFICATION_RANK.secret)
  })

  test("isDataClassification guards the vocabulary", () => {
    expect(isDataClassification("pii")).toBe(true)
    expect(isDataClassification("secret")).toBe(true)
    expect(isDataClassification("confidential")).toBe(false)
    expect(isDataClassification(2)).toBe(false)
  })

  test("maxClassification returns the most sensitive; public for an empty set", () => {
    expect(maxClassification(["public", "pii"])).toBe("pii")
    expect(maxClassification(["pii", "secret", "public"])).toBe("secret")
    expect(maxClassification([])).toBe("public")
  })

  test("classificationAtLeast compares against a floor", () => {
    expect(classificationAtLeast("secret", "pii")).toBe(true)
    expect(classificationAtLeast("pii", "pii")).toBe(true)
    expect(classificationAtLeast("public", "pii")).toBe(false)
  })
})

describe("route classification — reflection + lockfile", () => {
  const policy = {
    definitions: [{ id: "db.read", zone: "operational", access: "read" }],
    provenance: { imports: [], forbiddenImports: [] },
  } as const

  test("a declared classification is reflected on the route", () => {
    const app = server().get("/me", { classification: "pii" }, () => ({ email: "x@y.z" }))
    const [route] = reflectRoutes(app)
    expect(route?.classification).toBe("pii")
  })

  test("an undeclared classification is absent (defaults to nothing, not public)", () => {
    const app = server().get("/health", () => ({ ok: true }))
    const [route] = reflectRoutes(app)
    expect(route?.classification).toBeUndefined()
  })

  test("an invalid classification value is ignored by reflection", () => {
    // Force a bad value past the types to prove the runtime guard holds.
    const app = server().get("/x", { classification: "nonsense" as never }, () => ({ ok: true }))
    const [route] = reflectRoutes(app)
    expect(route?.classification).toBeUndefined()
  })

  test("classification is recorded in the capability lockfile so a change flips it", () => {
    const publicApp = server().get("/user", () => ({ id: 1 }))
    const piiApp = server().get("/user", { classification: "pii" }, () => ({ id: 1, ssn: "…" }))
    const evidence = { routes: [{ method: "GET", path: "/user", covered: true, evidence: [] }] }
    const before = snapshotCapabilities(evaluateCapabilityAssurance(publicApp, policy, evidence))
    const after = snapshotCapabilities(evaluateCapabilityAssurance(piiApp, policy, evidence))
    expect(before.routes[0]?.classification).toBeUndefined()
    expect(after.routes[0]?.classification).toBe("pii")
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after)) // lockfile drift → review
  })
})
