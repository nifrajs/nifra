import { expect, test } from "bun:test"
import { isSameOriginPath } from "../src/router/pattern.ts"
import { isSameOriginPath as fromServerEntry } from "../src/server.ts"

test("the browser-safe entry and the server entry export one isSameOriginPath", () => {
  expect(isSameOriginPath).toBe(fromServerEntry)
})

test("a path begins with one slash and nothing a URL parser resolves off-origin", () => {
  for (const path of [
    "/",
    "/a",
    "/a/b?x=1#y",
    "/caf%C3%A9",
    "/a b",
    "/a/../b",
    "/%5Cx",
    "/x.y/z",
  ]) {
    expect(isSameOriginPath(path)).toBe(true)
  }
  for (const path of [
    "",
    "a",
    "//evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "/\\evil.com",
    "/\t/evil.com",
    "/\r/evil.com",
    "/\n/evil.com",
    "/a\0b",
    "/a\u001fb",
    "/a\u007fb",
    "/.//evil.com/x",
    "/a/..//evil.com/x",
    "/%2e//evil.com/x",
  ]) {
    expect(isSameOriginPath(path)).toBe(false)
  }
})
