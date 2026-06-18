import { describe, expect, test } from "bun:test"
import { detectFileType } from "../src/detect.ts"
import { signDownloadUrl, verifyDownloadUrl } from "../src/sign.ts"
import { type ImageReencoder, stripImageMetadata } from "../src/strip.ts"
import { validateUpload } from "../src/validate.ts"

const bytesOf = (...nums: number[]): Uint8Array => new Uint8Array(nums)
const PNG = bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)
const JPEG = bytesOf(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0)
const PDF = bytesOf(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31)
const ZIP = bytesOf(0x50, 0x4b, 0x03, 0x04, 0, 0)
const WEBP = bytesOf(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)

// RIFF: "RIFF" + 4 size bytes + a 4-char form type at offset 8.
const riff = (form: string): Uint8Array =>
  bytesOf(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, ...[...form].map((c) => c.charCodeAt(0)))
// ISO-BMFF: 4 size bytes + "ftyp" + a 4-char major brand at offset 8.
const isobmff = (brand: string): Uint8Array =>
  bytesOf(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...[...brand].map((c) => c.charCodeAt(0)))

describe("detectFileType", () => {
  // One row per branch in detect.ts — every magic-byte path is exercised.
  const cases: ReadonlyArray<readonly [string, Uint8Array, string, string]> = [
    ["jpeg", JPEG, "image/jpeg", "jpg"],
    ["png", PNG, "image/png", "png"],
    ["gif", bytesOf(0x47, 0x49, 0x46, 0x38, 0x39, 0x61), "image/gif", "gif"],
    ["webp (RIFF/WEBP)", WEBP, "image/webp", "webp"],
    ["wav (RIFF/WAVE)", riff("WAVE"), "audio/wav", "wav"],
    ["avi (RIFF/AVI )", riff("AVI "), "video/x-msvideo", "avi"],
    ["mp4 (ftyp/isom)", isobmff("isom"), "video/mp4", "mp4"],
    ["avif (ftyp/avif)", isobmff("avif"), "image/avif", "avif"],
    ["heic (ftyp/heic)", isobmff("heic"), "image/heic", "heic"],
    ["heif (ftyp/mif1)", isobmff("mif1"), "image/heic", "heic"],
    ["m4a (ftyp/M4A )", isobmff("M4A "), "audio/mp4", "m4a"],
    ["m4b (ftyp/M4B )", isobmff("M4B "), "audio/mp4", "m4a"],
    ["webm (Matroska)", bytesOf(0x1a, 0x45, 0xdf, 0xa3, 0, 0), "video/webm", "webm"],
    ["ogg (OggS)", bytesOf(0x4f, 0x67, 0x67, 0x53, 0, 0), "audio/ogg", "ogg"],
    ["mp3 (ID3)", bytesOf(0x49, 0x44, 0x33, 0, 0, 0), "audio/mpeg", "mp3"],
    ["pdf (%PDF)", PDF, "application/pdf", "pdf"],
    ["zip (PK\\x03\\x04)", ZIP, "application/zip", "zip"],
    ["zip (PK\\x05\\x06 empty)", bytesOf(0x50, 0x4b, 0x05, 0x06, 0, 0), "application/zip", "zip"],
    ["gzip", bytesOf(0x1f, 0x8b, 0x08, 0, 0, 0), "application/gzip", "gz"],
  ]
  for (const [name, bytes, mime, ext] of cases) {
    test(`recognizes ${name}`, () => {
      expect(detectFileType(bytes)).toEqual({ mime, ext })
    })
  }

  test("returns null for unrecognized bytes", () => {
    expect(detectFileType(bytesOf(1, 2, 3, 4, 5, 6, 7, 8))).toBeNull()
  })

  test("returns null for an unknown RIFF form type (not webp/wav/avi)", () => {
    expect(detectFileType(riff("XXXX"))).toBeNull()
  })
})

describe("validateUpload", () => {
  test("accepts a recognized type under the cap", async () => {
    const r = await validateUpload(PNG, { maxBytes: 1000, accept: ["image/*"] })
    expect(r).toMatchObject({ ok: true, mime: "image/png", ext: "png" })
  })

  test("rejects an oversized payload (too_large)", async () => {
    const r = await validateUpload(new Uint8Array(2000), { maxBytes: 1000 })
    expect(r).toMatchObject({ ok: false, reason: "too_large" })
  })

  test("rejects an oversized Blob by its size without buffering", async () => {
    const blob = new Blob([new Uint8Array(2000)])
    const r = await validateUpload(blob, { maxBytes: 1000 })
    expect(r).toMatchObject({ ok: false, reason: "too_large" })
  })

  test("rejects a real type not in the allow-list (anti-Content-Type-spoof)", async () => {
    // A JPEG uploaded to a PNG-only field: the bytes win, not a client-set Content-Type.
    const r = await validateUpload(JPEG, { maxBytes: 1000, accept: ["image/png"] })
    expect(r).toMatchObject({
      ok: false,
      reason: "type_not_allowed",
      detected: { mime: "image/jpeg" },
    })
  })

  test("rejects unrecognized + empty", async () => {
    expect(await validateUpload(bytesOf(1, 2, 3, 4), { maxBytes: 100 })).toMatchObject({
      ok: false,
      reason: "unrecognized",
    })
    expect(await validateUpload(new Uint8Array(0), { maxBytes: 100 })).toMatchObject({
      ok: false,
      reason: "empty",
    })
  })

  test("an m4a audio file passes an audio/* allow-list and is rejected by video/* (not mislabeled mp4)", async () => {
    const m4a = bytesOf(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20) // ftyp/"M4A "
    expect(await validateUpload(m4a, { maxBytes: 1000, accept: ["audio/*"] })).toMatchObject({
      ok: true,
      mime: "audio/mp4",
    })
    expect(await validateUpload(m4a, { maxBytes: 1000, accept: ["video/*"] })).toMatchObject({
      ok: false,
      reason: "type_not_allowed",
    })
  })

  test("reads a Blob to bytes when under the cap", async () => {
    const r = await validateUpload(new Blob([PNG]), { maxBytes: 1000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.bytes.byteLength).toBe(PNG.byteLength)
  })
})

describe("signDownloadUrl / verifyDownloadUrl", () => {
  const secret = "s3cret_padded_to_at_least_32_byte"

  test("a freshly-signed URL verifies", async () => {
    const signed = await signDownloadUrl("/uploads/a.png", secret, {
      expiresInSeconds: 60,
      now: 1000,
    })
    expect(signed).toContain("vsig=")
    expect(await verifyDownloadUrl(signed, secret, { now: 1000 })).toBe(true)
  })

  test("rejects after expiry", async () => {
    const signed = await signDownloadUrl("/uploads/a.png", secret, {
      expiresInSeconds: 60,
      now: 1000,
    })
    expect(await verifyDownloadUrl(signed, secret, { now: 1061 })).toBe(false) // exp = 1060
  })

  test("rejects a tampered path", async () => {
    const signed = await signDownloadUrl("/uploads/a.png", secret, {
      expiresInSeconds: 60,
      now: 1000,
    })
    const tampered = signed.replace("/uploads/a.png", "/uploads/secret.png")
    expect(await verifyDownloadUrl(tampered, secret, { now: 1000 })).toBe(false)
  })

  test("signs query params and rejects query tampering", async () => {
    const signed = await signDownloadUrl("/uploads/a.png?tenant=alpha&variant=thumb", secret, {
      expiresInSeconds: 60,
      now: 1000,
    })
    expect(await verifyDownloadUrl(signed, secret, { now: 1000 })).toBe(true)

    const changed = signed.replace("tenant=alpha", "tenant=beta")
    expect(await verifyDownloadUrl(changed, secret, { now: 1000 })).toBe(false)

    const added = `${signed}&download=1`
    expect(await verifyDownloadUrl(added, secret, { now: 1000 })).toBe(false)

    const removed = signed.replace("&variant=thumb", "")
    expect(await verifyDownloadUrl(removed, secret, { now: 1000 })).toBe(false)
  })

  test("query pair order and signature fields are part of the verification contract", async () => {
    const signed = await signDownloadUrl("/uploads/a.png?b=2&a=1", secret, {
      expiresInSeconds: 60,
      now: 1000,
    })
    const u = new URL(signed, "http://localhost")
    const exp = u.searchParams.get("vexp")
    const sig = u.searchParams.get("vsig")
    const reordered = `/uploads/a.png?a=1&b=2&vexp=${exp}&vsig=${sig}`

    expect(await verifyDownloadUrl(signed, secret, { now: 1000 })).toBe(true)
    expect(await verifyDownloadUrl(reordered, secret, { now: 1000 })).toBe(false)
    expect(await verifyDownloadUrl(`${signed}&vexp=${exp}`, secret, { now: 1000 })).toBe(false)
    expect(await verifyDownloadUrl(`${signed}&vsig=${sig}`, secret, { now: 1000 })).toBe(false)
  })

  test("rejects a secret weaker than the 256-bit floor (signing AND verifying)", async () => {
    const weak = "too-short" // < 32 bytes
    await expect(
      signDownloadUrl("/uploads/a.png", weak, { expiresInSeconds: 60, now: 1000 }),
    ).rejects.toThrow(/at least 32 bytes/)
    // A genuinely-signed URL must also fail to verify under a weak secret (the guard fires on import).
    const signed = await signDownloadUrl("/uploads/a.png", secret, {
      expiresInSeconds: 60,
      now: 1000,
    })
    await expect(verifyDownloadUrl(signed, weak, { now: 1000 })).rejects.toThrow(
      /at least 32 bytes/,
    )
  })

  test("rejects a wrong secret + a missing signature", async () => {
    const signed = await signDownloadUrl("/uploads/a.png", secret, {
      expiresInSeconds: 60,
      now: 1000,
    })
    expect(
      await verifyDownloadUrl(signed, "other_secret_padded_to_at_least_3", { now: 1000 }),
    ).toBe(false)
    expect(await verifyDownloadUrl("/uploads/a.png", secret, { now: 1000 })).toBe(false)
  })
})

describe("stripImageMetadata", () => {
  test("re-encodes via the backend at the intrinsic width, dropping metadata", async () => {
    const calls: Array<{ width: number; format: string; quality: number }> = []
    const backend: ImageReencoder = {
      probe: async () => ({ width: 800, height: 600, format: "jpeg" }),
      transform: async (input) => {
        calls.push({ width: input.width, format: input.format, quality: input.quality })
        return { bytes: bytesOf(0xde, 0xad, 0xbe, 0xef) } // "clean" re-encoded bytes
      },
    }
    const out = await stripImageMetadata(JPEG, backend)
    expect(Array.from(out)).toEqual([0xde, 0xad, 0xbe, 0xef])
    expect(calls).toEqual([{ width: 800, format: "jpeg", quality: 82 }])
  })

  test("honors an explicit output format + quality", async () => {
    const backend: ImageReencoder = {
      probe: async () => ({ width: 100, height: 100, format: "png" }),
      transform: async (input) => ({ bytes: bytesOf(input.format === "webp" ? 1 : 0) }),
    }
    const out = await stripImageMetadata(PNG, backend, { format: "webp", quality: 90 })
    expect(Array.from(out)).toEqual([1])
  })
})
