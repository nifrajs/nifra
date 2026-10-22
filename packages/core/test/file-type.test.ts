import { describe, expect, test } from "bun:test"
import { DETECTABLE_MIME_TYPES, detectFileType, FILE_TYPE_PREFIX_BYTES } from "../src/file-type.ts"

const bytesOf = (...nums: number[]): Uint8Array => new Uint8Array(nums)
const PNG = bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)
const JPEG = bytesOf(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0)
const PDF = bytesOf(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31)
const ZIP = bytesOf(0x50, 0x4b, 0x03, 0x04, 0, 0)
const WEBP = bytesOf(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)

// RIFF: "RIFF" + 4 size bytes + a 4-char form type at offset 8.
const riff = (form: string): Uint8Array =>
  bytesOf(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, ...[...form].map((c) => c.charCodeAt(0)))
// ISO-BMFF: 4 size bytes + "ftyp" + a 4-char major brand at offset 8, then a minor version and the
// compatible brands, to the end of the box.
const isobmff = (brand: string, ...compatible: string[]): Uint8Array => {
  const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))
  const tail = [0, 0, 0, 0, ...compatible.flatMap(ascii)]
  return bytesOf(0, 0, 0, 12 + tail.length, ...ascii("ftyp"), ...ascii(brand), ...tail)
}

describe("detectFileType", () => {
  // One row per branch in file-type.ts - every magic-byte path is exercised.
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
    ["avif (ftyp/mif1, compatible avif)", isobmff("mif1", "miaf", "avif"), "image/avif", "avif"],
    ["heif sequence (ftyp/msf1)", isobmff("msf1", "heic"), "image/heic", "heic"],
    ["m4a (ftyp/M4A )", isobmff("M4A "), "audio/mp4", "m4a"],
    ["m4b (ftyp/M4B )", isobmff("M4B "), "audio/mp4", "m4a"],
    ["webm (Matroska)", bytesOf(0x1a, 0x45, 0xdf, 0xa3, 0, 0), "video/webm", "webm"],
    ["ogg (OggS)", bytesOf(0x4f, 0x67, 0x67, 0x53, 0, 0), "audio/ogg", "ogg"],
    ["mp3 (ID3)", bytesOf(0x49, 0x44, 0x33, 0, 0, 0), "audio/mpeg", "mp3"],
    ["mp3 (untagged MPEG-1 Layer III frame)", bytesOf(0xff, 0xfb, 0x90, 0x64), "audio/mpeg", "mp3"],
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

  test("DETECTABLE_MIME_TYPES lists exactly the types the detector returns", () => {
    expect([...DETECTABLE_MIME_TYPES].sort()).toEqual([...new Set(cases.map((c) => c[2]))].sort())
  })

  test("FILE_TYPE_PREFIX_BYTES leading bytes are enough for every type", () => {
    for (const [, bytes, mime] of cases) {
      const padded = new Uint8Array(64)
      padded.set(bytes)
      expect(detectFileType(padded.subarray(0, FILE_TYPE_PREFIX_BYTES))?.mime).toBe(mime)
    }
    // One byte less loses the fourth compatible brand, so the constant is not over-generous.
    const fourth = isobmff("mif1", "miaf", "MA1B", "MiHB", "avif")
    expect(detectFileType(fourth)?.mime).toBe("image/avif")
    expect(detectFileType(fourth.subarray(0, FILE_TYPE_PREFIX_BYTES - 1))?.mime).toBe("image/heic")
  })

  test("an ftyp box's declared size does not reach past the prefix", () => {
    // A fifth compatible brand lies beyond FILE_TYPE_PREFIX_BYTES, so it never decides the type, and a
    // box claiming megabytes of brands is read no further than the prefix.
    const fifth = isobmff("mif1", "miaf", "MA1B", "MiHB", "msf1", "avif")
    expect(detectFileType(fifth)?.mime).toBe("image/heic")
    const claimed = new Uint8Array(8 * 1024 * 1024)
    claimed.set(isobmff("mif1"))
    claimed.set([0x7f, 0xff, 0xff, 0xff], 0)
    claimed.set(isobmff("avif").subarray(8, 12), claimed.length - 4)
    expect(detectFileType(claimed)?.mime).toBe("image/heic")
  })

  test("returns null for unrecognized bytes", () => {
    expect(detectFileType(bytesOf(1, 2, 3, 4, 5, 6, 7, 8))).toBeNull()
  })

  test("an MPEG frame sync with reserved fields, or AAC's ADTS sync, is not an MP3", () => {
    expect(detectFileType(bytesOf(0xff, 0xf1, 0x50, 0x80))).toBeNull() // ADTS: layer 00
    expect(detectFileType(bytesOf(0xff, 0xeb, 0x90, 0x64))).toBeNull() // reserved version 01
    expect(detectFileType(bytesOf(0xff, 0xfb, 0xf0, 0x64))).toBeNull() // bitrate index 1111
    expect(detectFileType(bytesOf(0xff, 0xfb, 0x9c, 0x64))).toBeNull() // reserved sample rate 11
  })

  test("returns null for an unknown RIFF form type (not webp/wav/avi)", () => {
    expect(detectFileType(riff("XXXX"))).toBeNull()
  })
})
