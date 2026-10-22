import { describe, expect, test } from "bun:test"
import { signDownloadUrl, verifyDownloadUrl } from "../src/sign.ts"
import { ImagePixelLimitError, type ImageReencoder, stripImageMetadata } from "../src/strip.ts"
import { validateUpload } from "../src/validate.ts"

const bytesOf = (...nums: number[]): Uint8Array => new Uint8Array(nums)
const PNG = bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)
const JPEG = bytesOf(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0)

describe("validateUpload", () => {
  test("rejects non-finite, fractional, or negative byte limits", async () => {
    for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      await expect(validateUpload(PNG, { maxBytes })).rejects.toThrow(/maxBytes/)
    }
  })

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
    const r = await validateUpload(new Blob([PNG.slice()]), { maxBytes: 1000 })
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

  test("rejects an expiry spelled any way but the signed one", async () => {
    const signed = await signDownloadUrl("/uploads/a.png", secret, {
      expiresInSeconds: 60,
      now: 1000,
    })
    expect(signed).toContain("vexp=1060")
    for (const alias of ["vexp=01060", "vexp=0001060"])
      expect(
        await verifyDownloadUrl(signed.replace("vexp=1060", alias), secret, { now: 1000 }),
      ).toBe(false)
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

  test("accepts only the canonical spelling of a signature", async () => {
    const signed = await signDownloadUrl("/uploads/a.png", secret, {
      expiresInSeconds: 60,
      now: 1000,
    })
    const sig = new URL(signed, "http://x").searchParams.get("vsig") ?? ""
    // 32 bytes → 43 chars; the last char carries 2 unused bits that `atob` would ignore.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const twin = `${sig.slice(0, -1)}${alphabet[alphabet.indexOf(sig.at(-1) ?? "") | 1]}`
    expect(await verifyDownloadUrl(signed.replace(sig, twin), secret, { now: 1000 })).toBe(false)
    const spaced = signed.replace(sig, `${sig.slice(0, 4)}%20${sig.slice(4)}`)
    expect(await verifyDownloadUrl(spaced, secret, { now: 1000 })).toBe(false)
  })

  test("signs only an expiry the verifier accepts", async () => {
    const at = (expiresInSeconds: number, now: number) =>
      signDownloadUrl("/uploads/a.png", secret, { expiresInSeconds, now })
    const signed = await at(1, 100)
    expect(await verifyDownloadUrl(signed, secret, { now: 101 })).toBe(true)
    expect(await verifyDownloadUrl(signed, secret, { now: 102 })).toBe(false)
    for (const ttl of [0.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(at(ttl, 100)).rejects.toThrow("expiresInSeconds must be a whole number")
    for (const now of [100.5, -1, Number.NaN])
      await expect(at(60, now)).rejects.toThrow("now must be a whole")
    await expect(at(1, Number.MAX_SAFE_INTEGER)).rejects.toThrow("the expiry is out of range")
    const largest = await at(1, Number.MAX_SAFE_INTEGER - 1)
    expect(await verifyDownloadUrl(largest, secret, { now: Number.MAX_SAFE_INTEGER - 1 })).toBe(
      true,
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

  test("refuses a source over the pixel cap before the backend decodes it", async () => {
    let decoded = 0
    const backend = (width: number, height: number): ImageReencoder => ({
      probe: async () => ({ width, height, format: "png" }),
      transform: async () => {
        decoded++
        return { bytes: bytesOf(1) }
      },
    })
    // A 60 MP header compresses to a few hundred kilobytes and passes a 1 MiB upload cap.
    await expect(stripImageMetadata(PNG, backend(6_000, 10_000))).rejects.toBeInstanceOf(
      ImagePixelLimitError,
    )
    await expect(
      stripImageMetadata(PNG, backend(200, 200), { maxPixels: 10_000 }),
    ).rejects.toMatchObject({ width: 200, height: 200, maxPixels: 10_000 })
    await expect(stripImageMetadata(PNG, backend(0, 10))).rejects.toThrow(
      /invalid image dimensions/,
    )
    await expect(stripImageMetadata(PNG, backend(10, 10), { maxPixels: 0 })).rejects.toThrow(
      /maxPixels/,
    )
    expect(decoded).toBe(0)
    expect(Array.from(await stripImageMetadata(PNG, backend(6_000, 6_000)))).toEqual([1])
    expect(decoded).toBe(1)
  })
})
