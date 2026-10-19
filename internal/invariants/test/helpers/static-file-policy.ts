import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { FileVersion, ReadAt } from "../../../../packages/core/src/static-file.ts"

/** Both runtime copies must implement the same cache-validation and byte-identity contract. */
export function verifyStaticFilePolicy(
  name: string,
  policy: typeof import("../../../../packages/core/src/static-file.ts"),
): void {
  describe(name, () => {
    const {
      CONTENT_TAG_MAX,
      CONTENT_TYPES,
      contentTags,
      contentTypeOf,
      ifRangeAllowsPartial,
      isHiddenPath,
      isNotModified,
      lastModifiedOf,
      streamedLastModifiedOf,
    } = policy
    test("metadata fallback tags never identify files on another instance", async () => {
      const version = { dev: 1, ino: 42, size: CONTENT_TAG_MAX + 1, mtimeMs: 1_000, ctimeMs: 1_000 }
      const a = contentTags(createHash, { now: () => 10_000 })
      const b = contentTags(createHash, { now: () => 10_000 })
      const read: ReadAt = async () => {
        throw new Error("large files must not be read")
      }
      const first = await a.ofFile("/video", version, read)
      expect(first).toBeDefined()
      expect(await a.ofFile("/video", version, read)).toBe(first)
      expect(await b.ofFile("/video", version, read)).not.toBe(first)
    })

    test("contentTypeOf reads the last extension of the file name, case-insensitively", () => {
      expect(contentTypeOf("/srv/app/assets/page-1a2b.js")).toBe("text/javascript; charset=utf-8")
      expect(contentTypeOf("logo.SVG")).toBe("image/svg+xml")
      expect(contentTypeOf("C:\\site\\guide.pdf")).toBe("application/pdf")
      expect(contentTypeOf("archive.tar.zip")).toBe("application/zip")
    })

    test("contentTypeOf answers octet-stream for no extension, a dotfile, or a dot in a directory", () => {
      for (const path of [
        "token",
        ".env",
        "/srv/.well-known/acme",
        "/v1.2/file",
        "data.unknown",
        "x.",
      ]) {
        expect(contentTypeOf(path)).toBe("application/octet-stream")
      }
    })

    test("the table is frozen: a consumer cannot retype a file for every other one", () => {
      expect(Object.isFrozen(CONTENT_TYPES)).toBe(true)
    })

    test("isHiddenPath refuses any dot-segment but .well-known, on either separator", () => {
      for (const rel of [".env", "a/.git/config", "assets\\.cache\\x.js", ".well-known/../.env"]) {
        expect(isHiddenPath(rel)).toBe(true)
      }
      for (const rel of [".well-known/security.txt", "assets/logo..png", "robots.txt", ""]) {
        expect(isHiddenPath(rel)).toBe(false)
      }
    })

    // Half a second past the whole second an HTTP date names.
    const MODIFIED = Date.parse("Sat, 01 Jan 2022 00:00:00 GMT") + 500
    const TAG = '"GXx8YO-KhHCjjRqSEr396c"'

    test("isNotModified: If-Modified-Since from the file's own second on, at HTTP-date precision", () => {
      const since = (value: string | null, lastModified: number | undefined) =>
        isNotModified(null, value, undefined, lastModified)
      expect(since("Sat, 01 Jan 2022 00:00:00 GMT", MODIFIED)).toBe(true)
      expect(since("Wed, 01 Jan 2031 00:00:00 GMT", MODIFIED)).toBe(true)
      expect(since("Fri, 31 Dec 2021 23:59:59 GMT", MODIFIED)).toBe(false)
      expect(since("yesterday", MODIFIED)).toBe(false)
      expect(since(null, MODIFIED)).toBe(false)
      expect(since("Wed, 01 Jan 2031 00:00:00 GMT", undefined)).toBe(false)
    })

    test("isNotModified: If-None-Match decides alone, by weak comparison, and * matches any file", () => {
      const current = "Wed, 01 Jan 2031 00:00:00 GMT"
      for (const header of [TAG, `W/${TAG}`, `"stale", ${TAG}`, " * "]) {
        expect(isNotModified(header, null, TAG, MODIFIED)).toBe(true)
      }
      expect(isNotModified(TAG, null, `W/${TAG}`, MODIFIED)).toBe(true)
      // A stale tag suppresses a current date, and with no tag of its own only * matches a file.
      expect(isNotModified('"stale"', current, TAG, MODIFIED)).toBe(false)
      expect(isNotModified(TAG, current, undefined, MODIFIED)).toBe(false)
      expect(isNotModified("*", null, undefined, undefined)).toBe(true)
    })

    test("ifRangeAllowsPartial: the file's strong tag, or its exact date where it has none", () => {
      expect(ifRangeAllowsPartial(null, TAG, MODIFIED)).toBe(true)
      expect(ifRangeAllowsPartial(null, undefined, undefined)).toBe(true)
      expect(ifRangeAllowsPartial(` ${TAG} `, TAG, MODIFIED)).toBe(true)
      expect(ifRangeAllowsPartial(" Sat, 01 Jan 2022 00:00:00 GMT ", undefined, MODIFIED)).toBe(
        true,
      )
      // A weak tag compares only weakly, so a date is still the strongest validator it has.
      expect(ifRangeAllowsPartial("Sat, 01 Jan 2022 00:00:00 GMT", `W/${TAG}`, MODIFIED)).toBe(true)
      for (const [value, etag, lastModified] of [
        ["Sat, 01 Jan 2022 00:00:00 GMT", TAG, MODIFIED],
        ["Fri, 31 Dec 2021 23:59:59 GMT", undefined, MODIFIED],
        ["Wed, 01 Jan 2031 00:00:00 GMT", undefined, MODIFIED],
        ["Sat, 01 Jan 2022 00:00:00 GMT", undefined, undefined],
        ["not a date", undefined, MODIFIED],
        ['"stale"', TAG, MODIFIED],
        [`W/${TAG}`, TAG, MODIFIED],
        [`W/${TAG}`, `W/${TAG}`, MODIFIED],
        [TAG, `W/${TAG}`, MODIFIED],
        [TAG, undefined, MODIFIED],
      ] as const) {
        expect([value, etag, ifRangeAllowsPartial(value, etag, lastModified)]).toEqual([
          value,
          etag,
          false,
        ])
      }
    })

    const version = (fields: Partial<FileVersion> = {}): FileVersion => ({
      dev: 1,
      ino: 2,
      size: 5,
      mtimeMs: MODIFIED,
      ctimeMs: MODIFIED,
      ...fields,
    })

    test("lastModifiedOf: the mtime only while the file's own last change set it", () => {
      expect(lastModifiedOf(version())).toBe(MODIFIED)
      expect(lastModifiedOf(version({ ctimeMs: MODIFIED + 0.1 }))).toBe(MODIFIED)
      // Deno reports the ctime truncated to its second.
      expect(lastModifiedOf(version({ ctimeMs: MODIFIED - 500 }))).toBe(MODIFIED)
      for (const fields of [
        { ctimeMs: MODIFIED + 86_400_000 },
        { mtimeMs: 1000, ctimeMs: MODIFIED },
        { mtimeMs: 0, ctimeMs: 0 },
        { mtimeMs: MODIFIED + 5000 },
        { ctimeMs: Number.NaN },
        { mtimeMs: Number.NaN },
      ]) {
        expect([fields, lastModifiedOf(version(fields))]).toEqual([fields, undefined])
      }
    })

    const sha = (text: string) =>
      `"${createHash("sha256").update(text).digest("base64url").slice(0, 22)}"`

    /** A file of `text` read through `read`, counting the reads. */
    function file(text: string, chunk = Number.POSITIVE_INFINITY) {
      const bytes = new TextEncoder().encode(text)
      const reads: number[] = []
      const read: ReadAt = async (into, position) => {
        reads.push(position)
        const part = bytes.subarray(position, position + Math.min(into.length, chunk))
        into.set(part)
        return part.length
      }
      return { bytes, reads, read }
    }

    test("contentTags: a version is tagged by its bytes, and remembered once its change has settled", async () => {
      let now = MODIFIED + 10_000
      const tags = contentTags(createHash, { now: () => now })
      const first = file("first")
      expect(tags.ofBytes("/a", version(), first.bytes)).toBe(sha("first"))
      expect(tags.cached("/a", version())).toBe(sha("first"))
      // Any field of the version differing is another version.
      for (const fields of [{ ctimeMs: MODIFIED + 1 }, { ino: 3 }, { dev: 4 }, { size: 6 }]) {
        expect(tags.cached("/a", version(fields))).toBeUndefined()
      }
      expect(tags.cached("/b", version())).toBeUndefined()
      // Changed under 2 s ago, a file may change again without its stat showing it: not remembered.
      now = MODIFIED + 1000
      const racy = version({ ctimeMs: MODIFIED + 1 })
      expect(await tags.ofFile("/r", racy, first.read)).toBe(sha("first"))
      expect(tags.cached("/r", racy)).toBeUndefined()
      // Nor bytes that are not the whole version, as when the file shrank since its stat.
      now = MODIFIED + 10_000
      expect(tags.ofBytes("/s", version({ size: 9 }), first.bytes)).toBe(sha("first"))
      expect(tags.cached("/s", version({ size: 9 }))).toBeUndefined()
    })

    test("streamedLastModifiedOf dates a streamed file only once its change has settled", () => {
      const settled = version({ ctimeMs: MODIFIED })
      expect(streamedLastModifiedOf(settled, MODIFIED + 1999)).toBeUndefined()
      expect(streamedLastModifiedOf(settled, MODIFIED + 2000)).toBe(MODIFIED)
      // Settled, but dated by a copy rather than its own write: undated, as lastModifiedOf has it.
      expect(streamedLastModifiedOf(version({ mtimeMs: 1 }), MODIFIED + 10_000)).toBeUndefined()
    })

    test("contentTags: a larger snapshot reuses its tag only when a restat shows no write", async () => {
      const tags = contentTags(createHash, { now: () => MODIFIED + 10_000 })
      const size = 24 * 1024 + 1
      const at = version({ size })
      const first = "a".repeat(size)
      expect(tags.ofBytes("/s", at, file(first).bytes)).toBe(sha(first))
      // Other bytes under the same version tell a reused tag from a fresh hash.
      const other = file("b".repeat(size)).bytes
      expect(await tags.ofSnapshot("/s", at, other, async () => at)).toBe(sha(first))
      const written = async () => version({ size, ctimeMs: MODIFIED + 9000 })
      expect(await tags.ofSnapshot("/s", at, other, written)).toBe(sha("b".repeat(size)))
      // A small snapshot is hashed outright: that costs less than the restat.
      const small = version({ size: 5 })
      tags.ofBytes("/t", small, file("small").bytes)
      const unread = async () => {
        throw new Error("restat")
      }
      expect(await tags.ofSnapshot("/t", small, file("other").bytes, unread)).toBe(sha("other"))
      // The cut sits at 4 KiB unless the tagger is given its own.
      const now = () => MODIFIED + 10_000
      for (const [cutTags, cut] of [
        [contentTags(createHash, { now }), 4 * 1024],
        [contentTags(createHash, { now, rehashMax: 64 }), 64],
      ] as const) {
        for (const length of [cut, cut + 1]) {
          const sized = version({ size: length })
          cutTags.ofBytes(`/cut${length}`, sized, file("a".repeat(length)).bytes)
          const again = file("b".repeat(length)).bytes
          const restat = length > cut ? async () => sized : unread
          expect(await cutTags.ofSnapshot(`/cut${length}`, sized, again, restat)).toBe(
            sha((length > cut ? "a" : "b").repeat(length)),
          )
        }
      }
    })

    test("contentTags reads a file whole in chunks, once per version however many ask", async () => {
      const tags = contentTags(createHash, { now: () => MODIFIED + 10_000 })
      const text = "x".repeat(2 * 1024 * 1024 + 3)
      const big = file(text, 300_000)
      const at = version({ size: text.length })
      const [a, b] = await Promise.all([
        tags.ofFile("/big", at, big.read),
        tags.ofFile("/big", at, big.read),
      ])
      expect([a, b]).toEqual([sha(text), sha(text)])
      expect(big.reads[0]).toBe(0)
      expect(big.reads.length).toBe(Math.ceil(text.length / 300_000))
      expect(tags.cached("/big", at)).toBe(sha(text))
      // A version that changed while it was being read is read again, not joined.
      const other = file("y".repeat(text.length))
      const [c, d] = await Promise.all([
        tags.ofFile("/big", version({ size: text.length, ino: 9 }), other.read),
        tags.ofFile("/big", at, big.read),
      ])
      expect([c, d]).toEqual([sha("y".repeat(text.length)), sha(text)])
      // A file that ends early is tagged as read, and not remembered.
      const short = version({ size: 100 })
      expect(await tags.ofFile("/short", short, file("short").read)).toBe(sha("short"))
      expect(tags.cached("/short", short)).toBeUndefined()
      expect(await tags.ofFile("/empty", version({ size: 0 }), file("").read)).toBe(sha(""))
    })

    test("contentTags: a failed read reaches every waiter, and the next request reads afresh", async () => {
      const tags = contentTags(createHash, { now: () => MODIFIED + 10_000 })
      const failing: ReadAt = async () => {
        throw new Error("EIO")
      }
      const results = await Promise.allSettled([
        tags.ofFile("/f", version(), failing),
        tags.ofFile("/f", version(), failing),
      ])
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
      expect(await tags.ofFile("/f", version(), file("fresh").read)).toBe(sha("fresh"))
    })

    test("contentTags forgets the earliest tag past its limit", () => {
      const tags = contentTags(createHash, { limit: 2, now: () => MODIFIED + 10_000 })
      const bytes = new TextEncoder().encode("first")
      for (const path of ["/1", "/2", "/1", "/3"]) tags.ofBytes(path, version(), bytes)
      expect(["/1", "/2", "/3"].map((path) => tags.cached(path, version()) !== undefined)).toEqual([
        true,
        false,
        true,
      ])
    })

    test("contentTags tags a file past CONTENT_TAG_MAX by its identity, without reading it", async () => {
      const tags = contentTags(createHash, { now: () => MODIFIED + 10_000 })
      const unread: ReadAt = async () => {
        throw new Error("read")
      }
      const huge = version({ size: CONTENT_TAG_MAX + 1 })
      const tag = await tags.ofFile("/huge", huge, unread)
      expect(tag).toMatch(/^"[\w-]{22}"$/)
      expect(await tags.ofFile("/huge", huge, unread)).toBe(tag)
      for (const fields of [{ ctimeMs: MODIFIED + 1 }, { ino: 3 }, { dev: 4 }, { mtimeMs: 1 }]) {
        expect(await tags.ofFile("/huge", { ...huge, ...fields }, unread)).not.toBe(tag)
      }
      // No inode, no settled ctime: no identity to tag by.
      for (const fields of [
        { ino: Number.NaN },
        { ctimeMs: Number.NaN },
        { ctimeMs: MODIFIED + 9000 },
      ]) {
        expect(await tags.ofFile("/huge", { ...huge, ...fields }, unread)).toBeUndefined()
      }
    })
  })
}
