import { describe, expect, test } from "bun:test"
import {
  buildNifraManifest,
  canonicalManifest,
  diffNifraManifests,
  evaluateCapabilityAssurance,
  evaluateRouteAssurance,
  parseNifraManifest,
  parseNifraManifestSignature,
  serializeNifraManifest,
  serializeNifraManifestSignature,
  server,
  signNifraManifest,
  verifyNifraManifestSignature,
} from "../src/index.ts"

const policy = {
  rules: [{ name: "all", match: {}, require: [] }],
} as const

const capabilityPolicy = {
  definitions: [{ id: "db.read", zone: "domain", access: "read" }],
  provenance: { imports: [], forbiddenImports: [] },
} as const

async function manifest(source: unknown) {
  const routes = (source as { routes(): readonly { method: string; path: string }[] }).routes()
  return buildNifraManifest({
    source,
    assurance: evaluateRouteAssurance(source, policy),
    capabilities: evaluateCapabilityAssurance(source, capabilityPolicy, {
      routes: routes.map((route) => ({
        method: route.method,
        path: route.path,
        covered: true,
        evidence:
          route.path === "/users"
            ? [{ id: "db.read", kind: "static" as const, source: "repo" }]
            : [],
      })),
    }),
  })
}

describe("signed versioned Nifra manifest", () => {
  test("emission is deterministic across route registration and object-key order", async () => {
    const a = server()
      .post(
        "/users",
        {
          capabilities: ["db.read"],
          body: { type: "object", properties: { name: { type: "string" } } } as never,
        },
        () => ({}),
      )
      .get("/health", () => ({ ok: true }))
    const b = server()
      .get("/health", () => ({ ok: true }))
      .post(
        "/users",
        {
          capabilities: ["db.read"],
          body: { properties: { name: { type: "string" } }, type: "object" } as never,
        },
        () => ({}),
      )
    const first = await manifest(a)
    const second = await manifest(b)
    expect(first.contentHash).toBe(second.contentHash)
    expect(canonicalManifest(first)).toBe(canonicalManifest(second))
    expect(first.routes.map((route) => route.path)).toEqual(["/health", "/users"])
  })

  test("Ed25519 detached signatures verify and tampering fails", async () => {
    const built = await manifest(server().get("/health", () => ({ ok: true })))
    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair
    const signature = await signNifraManifest(built, {
      algorithm: "Ed25519",
      keyId: "test-key",
      sign: (payload) => {
        const owned = new Uint8Array(payload.byteLength)
        owned.set(payload)
        return crypto.subtle.sign("Ed25519", pair.privateKey, owned.buffer)
      },
    })
    expect(parseNifraManifestSignature(serializeNifraManifestSignature(signature))).toEqual(
      signature,
    )
    expect(await verifyNifraManifestSignature(built, signature, pair.publicKey)).toBe(true)
    expect(
      await verifyNifraManifestSignature(
        { ...built, contentHash: `0${built.contentHash.slice(1)}` },
        signature,
        pair.publicKey,
      ),
    ).toBe(false)
  })

  test("signing and sidecar parsing reject malformed operator material", async () => {
    const built = await manifest(server().get("/health", () => ({ ok: true })))
    await expect(
      signNifraManifest(built, {
        algorithm: "Ed25519",
        keyId: "bad\nkey",
        sign: () => new Uint8Array(64),
      }),
    ).rejects.toThrow(/signer requires/i)
    await expect(
      signNifraManifest(built, {
        algorithm: "Ed25519",
        keyId: "key",
        sign: () => new Uint8Array(8),
      }),
    ).rejects.toThrow(/64-byte/i)
    expect(() => parseNifraManifestSignature("not-json", "bad.sig")).toThrow(/valid JSON/)
    expect(() =>
      parseNifraManifestSignature(
        JSON.stringify({
          nifraManifestSignature: 1,
          algorithm: "Ed25519",
          keyId: "key",
          contentHash: "0".repeat(64),
          signature: "not+base64url",
        }),
      ),
    ).toThrow(/valid Ed25519/)
  })

  test("emission refuses failing assurance and canonical encoding rejects unsafe values", async () => {
    const app = server().get("/health", () => ({ ok: true }))
    await expect(
      buildNifraManifest({
        source: app,
        assurance: { ok: false, routes: [], findings: [] },
      }),
    ).rejects.toThrow(/failing route assurance/)
    await expect(
      buildNifraManifest({
        source: app,
        capabilities: { ok: false, routes: [], findings: [] },
      }),
    ).rejects.toThrow(/failing capability assurance/)
    const built = await buildNifraManifest({ source: app })
    expect(() =>
      serializeNifraManifest({
        ...built,
        routes: [{ ...built.routes[0]!, schema: { response: { const: Number.NaN } as never } }],
      }),
    ).toThrow(/non-finite/)
    await expect(
      signNifraManifest(
        { ...built, contentHash: "0".repeat(64) },
        {
          algorithm: "Ed25519",
          keyId: "key",
          sign: () => new Uint8Array(64),
        },
      ),
    ).rejects.toThrow(/contentHash/)
  })

  test("manifest parsing validates every governance section before trusting the hash", async () => {
    const hash = "0".repeat(64)
    const envelope = (route: unknown) =>
      JSON.stringify({ manifestVersion: 1, routes: [route], contentHash: hash })
    await expect(parseNifraManifest("{")).rejects.toThrow(/valid JSON/)
    await expect(parseNifraManifest("{}")).rejects.toThrow(/version 1/)
    await expect(parseNifraManifest(envelope({ method: "GET", path: "relative" }))).rejects.toThrow(
      /invalid route/,
    )
    await expect(parseNifraManifest(envelope({ method: "get", path: "/x" }))).rejects.toThrow(
      /route method/,
    )
    await expect(
      parseNifraManifest(
        JSON.stringify({
          manifestVersion: 1,
          routes: [
            { method: "GET", path: "/x" },
            { method: "GET", path: "/x" },
          ],
          contentHash: hash,
        }),
      ),
    ).rejects.toThrow(/duplicate route/)
    await expect(
      parseNifraManifest(envelope({ method: "GET", path: "/x", assurance: { evidence: [{}] } })),
    ).rejects.toThrow(/assurance material/)
    await expect(
      parseNifraManifest(
        envelope({
          method: "GET",
          path: "/x",
          capabilities: { declared: ["BAD"], evidenced: [], unproven: [], covered: true },
        }),
      ),
    ).rejects.toThrow(/capability material/)
    await expect(
      parseNifraManifest(
        envelope({
          method: "GET",
          path: "/x",
          classification: { fields: { "/id": "unknown" }, max: "pii" },
        }),
      ),
    ).rejects.toThrow(/response classification/)
    await expect(parseNifraManifest(envelope({ method: "GET", path: "/x" }))).rejects.toThrow(
      /contentHash mismatch/,
    )
  })

  test("diff reuses schema compatibility and treats new sensitivity/effects as breaking", async () => {
    const beforeApp = server().get(
      "/users",
      {
        capabilities: ["db.read"],
        response: { type: "object", properties: { id: { type: "string" } } } as never,
      },
      () => new Response(),
    )
    const afterApp = server().get(
      "/users",
      {
        capabilities: ["db.read"],
        classification: "pii",
        response: {
          type: "object",
          properties: { id: { type: "string" }, displayName: { type: "string" } },
        } as never,
      },
      () => new Response(),
    )
    const diff = diffNifraManifests(await manifest(beforeApp), await manifest(afterApp))
    expect(diff.changes).toContainEqual(
      expect.objectContaining({
        section: "response",
        severity: "compatible",
        field: "displayName",
      }),
    )
    expect(diff.changes).toContainEqual(
      expect.objectContaining({ section: "classification", severity: "breaking" }),
    )
    expect(diff.hasBreaking).toBe(true)
  })

  test("governance diff exposes assurance loss, capability expansion, and field sensitivity", () => {
    const before = {
      manifestVersion: 1 as const,
      contentHash: "0".repeat(64),
      routes: [
        {
          method: "POST",
          path: "/x",
          assurance: {
            rule: "old",
            evidence: [
              { id: "proof.keep", source: "a" },
              { id: "proof.remove", source: "b" },
            ],
          },
          capabilities: {
            declared: ["db.read", "old.cap"],
            evidenced: ["db.read"],
            unproven: [],
            covered: true,
          },
          classification: { max: "pii" as const, fields: { "/old": "pii" as const } },
        },
      ],
    }
    const after = {
      manifestVersion: 1 as const,
      contentHash: "1".repeat(64),
      routes: [
        {
          method: "POST",
          path: "/x",
          assurance: {
            rule: "new",
            evidence: [
              { id: "proof.keep", source: "a" },
              { id: "proof.add", source: "c" },
            ],
          },
          capabilities: {
            declared: ["db.read", "new.cap"],
            evidenced: ["db.read", "new.cap"],
            unproven: ["new.cap"],
            covered: false,
          },
          classification: {
            max: "secret" as const,
            fields: { "/new": "secret" as const },
          },
        },
      ],
    }
    const diff = diffNifraManifests(before, after)
    expect(diff.changes.map((change) => change.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("assurance rule changed"),
        expect.stringContaining("assurance evidence added"),
        expect.stringContaining("assurance evidence removed"),
        expect.stringContaining("declared capability added"),
        expect.stringContaining("declared capability removed"),
        expect.stringContaining("capability provenance coverage lost"),
        expect.stringContaining("response classification changed"),
        expect.stringContaining("response field classification changed"),
      ]),
    )
    expect(diff.hasBreaking).toBe(true)
  })
})
