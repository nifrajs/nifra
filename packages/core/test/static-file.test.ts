import { expect, test } from "bun:test"
import { CONTENT_TYPES, contentTypeOf, isHiddenPath } from "../src/static-file.ts"

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
