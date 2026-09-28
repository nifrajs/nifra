import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import type { AssuranceReport } from "../src/assurance.ts"
import type { CapabilityAssuranceReport } from "../src/capabilities.ts"
import {
  composeProjectEvidence,
  digestProjectEvidence,
  reflectedRoutesFromEvidence,
  serializeProjectEvidence,
  snapshotProjectEvidence,
} from "../src/evidence.ts"
import { buildNifraManifest } from "../src/manifest.ts"
import { server } from "../src/server.ts"

describe("canonical project evidence", () => {
  test("sorts routes and keeps only token-only contract facts", () => {
    const app = server()
      .post(
        "/users",
        {
          body: t.object({ name: t.string() }),
          response: t.object({ id: t.string() }),
        },
        () => ({ id: "user-1" }),
      )
      .get("/health", () => ({ ok: true }))
    const evidence = snapshotProjectEvidence(app, {
      sourceLocations: new Map([["POST\n/users", [{ file: "backend.ts", line: 4 }]]]),
    })

    expect(evidence.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /health",
      "POST /users",
    ])
    expect(evidence.routes[1]?.source).toEqual([{ file: "backend.ts", line: 4 }])
    expect(serializeProjectEvidence(evidence)).not.toContain("validate")
    expect(serializeProjectEvidence(evidence)).not.toContain("user-1")
  })

  test("composes stripped mount evidence under its public prefix", () => {
    const page = snapshotProjectEvidence(server().get("/", () => ({})))
    const api = snapshotProjectEvidence(server().get("/health", () => ({})))
    const composed = composeProjectEvidence([
      { evidence: page },
      { evidence: api, pathPrefix: "/api" },
    ])
    expect(composed.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /",
      "GET /api/health",
    ])
  })

  test("rejects duplicate public routes and stale report routes", () => {
    const first = snapshotProjectEvidence(server().get("/health", () => ({})))
    const second = snapshotProjectEvidence(server().get("/health", () => ({})))
    expect(() => composeProjectEvidence([{ evidence: first }, { evidence: second }])).toThrow(
      /duplicate composed route GET \/health/,
    )

    expect(() =>
      composeProjectEvidence([
        {
          evidence: {
            version: 1,
            routes: [],
            assurance: {
              ok: true,
              routes: [
                {
                  method: "GET",
                  path: "/stale",
                  evidence: [],
                  missing: [],
                  forbidden: [],
                },
              ],
              findings: [],
            },
          },
        },
      ]),
    ).toThrow(/assurance route GET \/stale is not present/)
  })

  test("manifest emission can consume the snapshot without a second route reflection", async () => {
    const app = server().get("/health", () => ({ ok: true }))
    const evidence = snapshotProjectEvidence(app)
    const manifest = await buildNifraManifest({ evidence })
    expect(manifest.routes).toEqual([{ method: "GET", path: "/health" }])
  })

  test("offline projections reuse one reflection pass and receive token-only schemas", () => {
    let reflections = 0
    const source = {
      routes: () => {
        reflections += 1
        return [
          {
            method: "GET",
            path: "/users/:id",
            schema: { params: { jsonSchema: { type: "object" } } },
          },
        ]
      },
    }
    const evidence = snapshotProjectEvidence(source)
    const reflected = reflectedRoutesFromEvidence(evidence)

    expect(reflections).toBe(1)
    expect(reflected).toEqual([
      {
        method: "GET",
        path: "/users/:id",
        schema: {
          params: { standard: undefined, jsonSchema: { type: "object" }, fields: undefined },
        },
      },
    ])
  })

  test("canonicalizes assurance provenance and evidence order", () => {
    const first = snapshotProjectEvidence([
      {
        method: "GET",
        path: "/secure",
        assurance: [
          { id: "nifra.z", source: "z", provenance: "runtime" },
          { id: "nifra.a", source: "a", provenance: "declared" },
        ],
      },
    ])
    const second = snapshotProjectEvidence([
      {
        method: "GET",
        path: "/secure",
        assurance: [
          { id: "nifra.a", source: "a", provenance: "declared" },
          { id: "nifra.z", source: "z", provenance: "runtime" },
        ],
      },
    ])

    expect(serializeProjectEvidence(first)).toBe(serializeProjectEvidence(second))
    expect(serializeProjectEvidence(first)).toContain('"provenance":"declared"')
    expect(serializeProjectEvidence(first)).toContain('"provenance":"runtime"')
  })

  test("composes assurance and capability evidence with stripped root and wildcard paths", () => {
    const assurance: AssuranceReport = {
      ok: true,
      routes: [
        {
          method: "get",
          path: "/health",
          rule: "authenticated",
          evidence: [
            { id: "auth.session", source: "z", provenance: "runtime" },
            { id: "auth.session", source: "a", provenance: "declared" },
          ],
          missing: [],
          forbidden: [],
        },
      ],
      findings: [
        {
          code: "missing-evidence",
          method: "GET",
          path: "/health",
          evidence: "z",
          message: "missing z",
        },
        {
          code: "forbidden-evidence",
          method: "GET",
          path: "/health",
          evidence: "a",
          message: "forbidden a",
        },
      ],
    }
    const capabilities: CapabilityAssuranceReport = {
      ok: false,
      routes: [
        {
          method: "GET",
          path: "/health",
          declared: ["domain.read"],
          evidence: [
            { id: "domain.read", kind: "runtime", source: "z" },
            { id: "domain.read", kind: "static", source: "a" },
          ],
          unproven: ["domain.write"],
          covered: true,
        },
      ],
      findings: [
        {
          code: "unknown-capability",
          method: "GET",
          path: "/health",
          capability: "domain.write",
          message: "unknown capability",
        },
      ],
    }
    const child = snapshotProjectEvidence(
      [
        { method: "GET", path: "/", responseContract: "enforce" },
        { method: "GET", path: "/health" },
        { method: "GET", path: "*" },
      ],
      { assurance, capabilities },
    )
    const composed = composeProjectEvidence([{ evidence: child, pathPrefix: "/api///" }])

    expect(composed.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET *",
      "GET /api",
      "GET /api/health",
    ])
    expect(composed.routes.find((route) => route.path === "/api")?.responseContract).toBe("enforce")
    expect(composed.assurance?.ok).toBe(true)
    expect(composed.assurance?.routes[0]?.path).toBe("/api/health")
    expect(composed.assurance?.routes[0]?.evidence.map((item) => item.source)).toEqual(["a", "z"])
    expect(composed.assurance?.findings.map((finding) => finding.code)).toEqual([
      "forbidden-evidence",
      "missing-evidence",
    ])
    expect(composed.capabilities?.ok).toBe(false)
    expect(composed.capabilities?.routes[0]?.path).toBe("/api/health")
    expect(composed.capabilities?.routes[0]?.evidence.map((item) => item.source)).toEqual([
      "z",
      "a",
    ])
    expect(composed.capabilities?.findings[0]?.path).toBe("/api/health")
    expect(Object.isFrozen(composed)).toBe(true)
  })

  test("rejects malformed composition inputs and supports a stable digest", async () => {
    const base = snapshotProjectEvidence(server().get("/health", () => ({})))

    expect(() => composeProjectEvidence([{ evidence: base, pathPrefix: "api" }])).toThrow(
      'path prefix must start with "/"',
    )
    expect(() =>
      composeProjectEvidence([
        {
          evidence: {
            version: 1,
            routes: [],
            capabilities: {
              ok: true,
              routes: [
                {
                  method: "GET",
                  path: "/stale",
                  declared: [],
                  evidence: [],
                  unproven: [],
                  covered: true,
                },
              ],
              findings: [],
            },
          },
        },
      ]),
    ).toThrow(/capabilities route GET \/stale is not present/)
    expect(() =>
      composeProjectEvidence([{ evidence: { version: 2 as 1, routes: [] } as never }]),
    ).toThrow(/unsupported snapshot version/)
    expect(() => reflectedRoutesFromEvidence({ version: 2 as 1, routes: [] } as never)).toThrow(
      /unsupported snapshot version/,
    )

    const rooted = composeProjectEvidence([{ evidence: base, pathPrefix: "/" }])
    expect(rooted.routes[0]?.path).toBe("/health")
    const digest = await digestProjectEvidence(rooted)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).toBe(await digestProjectEvidence(rooted))
  })
})
