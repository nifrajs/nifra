import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { serializeProjectEvidence, snapshotProjectEvidence } from "../src/evidence.ts"
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

  test("manifest emission can consume the snapshot without a second route reflection", async () => {
    const app = server().get("/health", () => ({ ok: true }))
    const evidence = snapshotProjectEvidence(app)
    const manifest = await buildNifraManifest({ evidence })
    expect(manifest.routes).toEqual([{ method: "GET", path: "/health" }])
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
})
