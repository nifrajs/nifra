import { describe, expect, test } from "bun:test"
import { hasDotSegment, resolveDotSegments } from "../src/server/request-target.ts"

describe("hasDotSegment", () => {
  test("finds a dot segment, raw or encoded in either case, and a backslash", () => {
    for (const target of [
      "/users/..",
      "/users/../posts",
      "/users/%2e%2e/posts",
      "/users/%2E%2e",
      "/users/.%2E/x",
      "/users/%2e./x",
      "/a/./b",
      "/a/%2e/b",
      "/.",
      "/..",
      "/a\\b",
      "/users/..\\posts",
      "/a/..#frag",
      "http://h/a/../b",
      "https://h:8080/%2e%2e",
    ]) {
      expect([target, hasDotSegment(target)]).toEqual([target, true])
    }
  })

  test("leaves every other path alone", () => {
    for (const target of [
      "/",
      "/users/7",
      "/.well-known/x",
      "/a/.b",
      "/a/b.",
      "/a/...",
      "/a/..b",
      "/a/%2ex",
      "/a/%2e%2e%2fx",
      "/a%2fb",
      "/search?q=a%20b",
      "http://h",
      "*",
    ]) {
      expect([target, hasDotSegment(target)]).toEqual([target, false])
    }
  })

  test("may flag a query that looks like a segment, which resolving leaves as it is", () => {
    for (const target of ["/search?q=/../x", "/a?x=\\", "/a?x=/.", "http://h/?a=/.."]) {
      expect(resolveDotSegments(target)).toBe(target)
    }
  })

  test("flags every generated target the WHATWG parser would rewrite", () => {
    // Deterministic generator, so a failure names a target that can be replayed.
    let state = 0x1d0751
    const random = (bound: number): number => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return (((t ^ (t >>> 14)) >>> 0) % bound) | 0
    }
    // Every piece is text the parser keeps as written unless it is (part of) a dot segment.
    const pieces = [
      "a",
      "7",
      ".",
      "..",
      "...",
      "%2e",
      "%2E",
      ".%2e",
      "%2e%2E",
      ".a",
      "a.",
      "%2f",
      "\\",
    ]
    for (let round = 0; round < 5000; round++) {
      const segments: string[] = []
      const depth = 1 + random(4)
      for (let d = 0; d < depth; d++) {
        let segment = pieces[random(pieces.length)]!
        if (random(4) === 0) segment += pieces[random(pieces.length)]!
        segments.push(segment)
      }
      const path = `/${segments.join("/")}`
      const target = random(3) === 0 ? `${path}?q=/../x` : path
      const parsed = new URL(`http://localhost${target}`)
      if (!hasDotSegment(target)) expect([target, parsed.pathname]).toEqual([target, path])
      expect([target, resolveDotSegments(target)]).toEqual([
        target,
        parsed.pathname + parsed.search,
      ])
    }
  })
})

describe("resolveDotSegments", () => {
  test("resolves an origin-form target and keeps it origin-form", () => {
    expect(resolveDotSegments("/users/../posts?x=/../y")).toBe("/posts?x=/../y")
    expect(resolveDotSegments("/users/%2E%2e\\posts")).toBe("/posts")
    expect(resolveDotSegments("/a/./b/.")).toBe("/a/b/")
    expect(resolveDotSegments("/..")).toBe("/")
  })

  test("keeps a leading `//` a path on this origin", () => {
    expect(resolveDotSegments("//evil.example/../x")).toBe("//x")
  })

  test("resolves an absolute target and keeps it absolute", () => {
    expect(resolveDotSegments("http://h/a/../b?c")).toBe("http://h/b?c")
  })

  test("returns a target with no path as it arrived", () => {
    expect(resolveDotSegments("*\\..")).toBe("*\\..")
  })
})
