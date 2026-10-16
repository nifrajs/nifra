import { expect, test } from "bun:test"
import {
  CONTENT_TYPES,
  contentTypeOf,
  ifRangeAllowsPartial,
  isHiddenPath,
  isNotModifiedSince,
} from "../src/static-file.ts"

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

test("isNotModifiedSince: current from the file's own second on, at HTTP-date precision", () => {
  expect(isNotModifiedSince("Sat, 01 Jan 2022 00:00:00 GMT", MODIFIED)).toBe(true)
  expect(isNotModifiedSince("Wed, 01 Jan 2031 00:00:00 GMT", MODIFIED)).toBe(true)
  expect(isNotModifiedSince("Fri, 31 Dec 2021 23:59:59 GMT", MODIFIED)).toBe(false)
  expect(isNotModifiedSince("yesterday", MODIFIED)).toBe(false)
  expect(isNotModifiedSince(null, MODIFIED)).toBe(false)
  expect(isNotModifiedSince("Wed, 01 Jan 2031 00:00:00 GMT", undefined)).toBe(false)
})

test("ifRangeAllowsPartial: no header, or exactly the file's date; never a later one or a tag", () => {
  expect(ifRangeAllowsPartial(null, MODIFIED)).toBe(true)
  expect(ifRangeAllowsPartial(null, undefined)).toBe(true)
  expect(ifRangeAllowsPartial(" Sat, 01 Jan 2022 00:00:00 GMT ", MODIFIED)).toBe(true)
  for (const value of [
    "Fri, 31 Dec 2021 23:59:59 GMT",
    "Wed, 01 Jan 2031 00:00:00 GMT",
    '"0-64"',
    'W/"0-64"',
    "not a date",
  ]) {
    expect(ifRangeAllowsPartial(value, MODIFIED)).toBe(false)
  }
  expect(ifRangeAllowsPartial("Sat, 01 Jan 2022 00:00:00 GMT", undefined)).toBe(false)
})
