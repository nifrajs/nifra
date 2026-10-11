import { describe, expect, test } from "bun:test"
import {
  defineCapabilityPolicy,
  evaluateCapabilityAssurance,
  snapshotCapabilities,
} from "../src/capabilities.ts"
import {
  composeProjectEvidence,
  serializeProjectEvidence,
  snapshotProjectEvidence,
} from "../src/evidence.ts"
import { server } from "../src/index.ts"
import { NIFRA_BACKEND_EVIDENCE } from "../src/mount.ts"
import { reflectMounts } from "../src/reflection.ts"

/**
 * A mounted child is invisible to route reflection, so capability assurance cannot prove what it
 * does. These tests pin the two honest outcomes: a mount that states why it is not analyzed is a
 * listed known gap, and one that does not is a failure - never a silent hole.
 */

const policy = defineCapabilityPolicy({
  definitions: [{ id: "db.read", zone: "domain", access: "read" }],
  provenance: { imports: [], forbiddenImports: [] },
})

// Stands in for a handler closure from another package (better-auth's), whose effects nifra cannot read.
const thirdParty = { fetch: () => new Response("third party") }

const assure = (app: unknown) =>
  evaluateCapabilityAssurance(app, policy, {
    routes: [{ method: "GET", path: "/own", covered: true, evidence: [] }],
  })

describe("opaque mounts", () => {
  test("a blank or non-string reason is no reason: the mount stays undeclared", () => {
    const app = server()
      .mount({ path: "/a", app: thirdParty, opaque: " " })
      .mountFetch("/b", thirdParty.fetch, { opaque: 1 as never })
    expect(reflectMounts(app)).toEqual([{ path: "/a/*" }, { path: "/b/*" }])
    expect(assure(app).findings.map((finding) => finding.code)).toEqual([
      "opaque-mount-undeclared",
      "opaque-mount-undeclared",
    ])
  })

  test("reflectMounts lists every mount reflection cannot see into, with its declared reason", () => {
    const app = server()
      .mountFetch("/legacy/*", thirdParty.fetch)
      .mount({ path: "/api/auth", app: thirdParty, opaque: "  better-auth's own handler  " })
      .mount({ path: "/", app: thirdParty, fallbackOn: 404 })
    expect(reflectMounts(app)).toEqual([
      { path: "/*" },
      { path: "/api/auth/*", opaque: "better-auth's own handler" },
      { path: "/legacy/*" },
    ])
    expect(reflectMounts({})).toEqual([])
    expect(reflectMounts(undefined)).toEqual([])
  })

  test("a mount that publishes composed evidence is not reported: its routes arrive with it", () => {
    const composed = { fetch: thirdParty.fetch, [NIFRA_BACKEND_EVIDENCE]: async () => ({}) }
    expect(reflectMounts(server().mount({ path: "/api", app: composed }))).toEqual([])
  })

  test("a declared opaque mount is a known gap and leaves the report passing", () => {
    const app = server()
      .get("/own", { capabilities: ["db.read"] }, () => ({ ok: true }))
      .mount({ path: "/api/auth", app: thirdParty, opaque: "better-auth's own handler" })
    const report = assure(app)
    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.gaps).toEqual([
      { kind: "opaque-mount", path: "/api/auth/*", reason: "better-auth's own handler" },
    ])
  })

  test("an undeclared mount fails the report and says how to fix it", () => {
    const app = server()
      .get("/own", { capabilities: ["db.read"] }, () => ({ ok: true }))
      .mount({ path: "/api/auth", app: thirdParty })
    const report = assure(app)
    expect(report.ok).toBe(false)
    expect(report.gaps).toBeUndefined()
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: "opaque-mount-undeclared",
        method: "*",
        path: "/api/auth/*",
      }),
    ])
    expect(report.findings[0]?.message).toContain("merge()")
    expect(report.findings[0]?.message).toContain("opaque")
  })

  test("a merged nifra server is analyzed route by route, so it is no gap", () => {
    const child = server().get("/own", { capabilities: ["db.read"] }, () => ({ ok: true }))
    const report = assure(server().merge(child))
    expect(report.ok).toBe(true)
    expect(report.routes.map((route) => route.path)).toEqual(["/own"])
    expect(report.gaps).toBeUndefined()
  })

  test("a composed mount list replaces reflection, as `nifra assure` passes it for a web app", () => {
    const app = server().get("/own", { capabilities: ["db.read"] }, () => ({ ok: true }))
    const report = evaluateCapabilityAssurance(app, policy, {
      routes: [{ method: "GET", path: "/own", covered: true, evidence: [] }],
      mounts: [{ path: "/api/auth/*", opaque: "better-auth" }],
    })
    expect(report.gaps).toEqual([
      { kind: "opaque-mount", path: "/api/auth/*", reason: "better-auth" },
    ])
  })
})

describe("opaque mounts in project evidence", () => {
  test("a mount-free app's snapshot has no mounts field, so its manifest hash is unchanged", () => {
    const snapshot = snapshotProjectEvidence(server().get("/a", () => "a"))
    expect("mounts" in snapshot).toBe(false)
    expect(serializeProjectEvidence(snapshot)).not.toContain("mounts")
  })

  test("the snapshot records each mount, and composition prefixes a stripped child's", () => {
    const child = server()
      .get("/session", () => "s")
      .mount({ path: "/flows", app: thirdParty, opaque: "better-auth" })
    const childEvidence = snapshotProjectEvidence(child)
    expect(childEvidence.mounts).toEqual([{ path: "/flows/*", opaque: "better-auth" }])

    const composed = composeProjectEvidence([
      { evidence: snapshotProjectEvidence(server().get("/", () => "home")) },
      { evidence: childEvidence, pathPrefix: "/api/auth" },
    ])
    expect(composed.routes.map((route) => route.path)).toEqual(["/", "/api/auth/session"])
    expect(composed.mounts).toEqual([{ path: "/api/auth/flows/*", opaque: "better-auth" }])
  })
})

describe("an opaque mount that declares its routes", () => {
  const declaringPolicy = defineCapabilityPolicy({
    definitions: [
      { id: "db.read", zone: "domain", access: "read" },
      { id: "session.write", zone: "domain", access: "write" },
    ],
    provenance: { imports: [], forbiddenImports: [] },
  })
  const reason = "a third-party auth handler"
  const declaring = (routes: readonly unknown[], why = reason) =>
    server()
      .get("/own", { capabilities: ["db.read"] }, () => ({ ok: true }))
      .mount({
        path: "/api/auth",
        app: thirdParty,
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: malformed entries are the point of some cases; reflection must refuse them.
        opaque: { reason: why, routes: routes as never },
      })
  const assureDeclared = (app: unknown) =>
    evaluateCapabilityAssurance(app, declaringPolicy, {
      routes: [{ method: "GET", path: "/own", covered: true, evidence: [] }],
    })
  const signIn = { method: "post", path: "/api/auth/sign-in", capabilities: ["session.write"] }
  const session = { method: "GET", path: "/api/auth/session", capabilities: ["db.read"] }

  test("reflection carries the declared routes, sorted, with the method upper-cased", () => {
    expect(reflectMounts(declaring([signIn, session]))).toEqual([
      {
        path: "/api/auth/*",
        opaque: reason,
        routes: [
          { method: "GET", path: "/api/auth/session", capabilities: ["db.read"] },
          { method: "POST", path: "/api/auth/sign-in", capabilities: ["session.write"] },
        ],
      },
    ])
  })

  test("assurance reports them as declared, keeps the gap and its reason, and passes", () => {
    const report = assureDeclared(declaring([signIn, session]))
    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.gaps).toEqual([{ kind: "opaque-mount", path: "/api/auth/*", reason }])
    expect(report.routes.find((route) => route.path === "/api/auth/sign-in")).toEqual({
      method: "POST",
      path: "/api/auth/sign-in",
      declared: ["session.write"],
      evidence: [],
      unproven: ["session.write"],
      covered: false,
      analysis: "declared",
    })
    expect(report.routes.find((route) => route.path === "/own")?.analysis).toBeUndefined()
    // The lockfile records the declaration too, so changing it is a reviewed diff.
    expect(snapshotCapabilities(report).routes.map((route) => route.path)).toEqual([
      "/api/auth/session",
      "/api/auth/sign-in",
      "/own",
    ])
  })

  test("a declared capability nifra does not know fails, as it does on a route", () => {
    const report = assureDeclared(
      declaring([{ method: "POST", path: "/api/auth/x", capabilities: ["payments.charge"] }]),
    )
    expect(report.ok).toBe(false)
    expect(report.findings.map((finding) => finding.code)).toEqual(["unknown-capability"])
  })

  test("a safe method that declares a domain write fails", () => {
    const report = assureDeclared(
      declaring([{ method: "GET", path: "/api/auth/sign-out", capabilities: ["session.write"] }]),
    )
    expect(report.findings.map((finding) => finding.code)).toEqual(["safe-method-domain-write"])
  })

  test("a malformed or out-of-mount declaration is refused at analysis, naming the entry", () => {
    expect(() => reflectMounts(declaring([{ method: "GET", path: "/elsewhere" }]))).toThrow(
      "outside",
    )
    expect(() => reflectMounts(declaring([{ method: "GET path", path: "/api/auth/a" }]))).toThrow(
      "method",
    )
    expect(() => reflectMounts(declaring([{ method: "GET", path: "/api/auth/a" }, null]))).toThrow(
      "route 2",
    )
    expect(() =>
      reflectMounts(declaring([{ method: "GET", path: "/api/auth/a", capabilities: [1] }])),
    ).toThrow("capabilities")
    expect(() => reflectMounts(declaring([session, session]))).toThrow("twice")
  })

  test("routes without a reason leave the mount undeclared, failing as before", () => {
    const report = assureDeclared(declaring([session], " "))
    expect(report.ok).toBe(false)
    expect(report.findings.map((finding) => finding.code)).toEqual(["opaque-mount-undeclared"])
    expect(report.routes.map((route) => route.path)).toEqual(["/own"])
  })

  test("project evidence carries them, and composition prefixes them", () => {
    const child = server().mount({
      path: "/flows",
      app: thirdParty,
      opaque: { reason, routes: [{ method: "GET", path: "/flows/start" }] },
    })
    const composed = composeProjectEvidence([
      { evidence: snapshotProjectEvidence(child), pathPrefix: "/api/auth" },
    ])
    expect(composed.mounts).toEqual([
      {
        path: "/api/auth/flows/*",
        opaque: reason,
        routes: [{ method: "GET", path: "/api/auth/flows/start", capabilities: [] }],
      },
    ])
  })
})
