import { describe, expect, test } from "bun:test"
import { originFor } from "../src/internal/request-url.ts"

const origin = (url: string): string => originFor(new Request(url))

describe("originFor", () => {
  test("is the URL's origin, normalized as `new URL` normalizes it", () => {
    for (const url of [
      "http://example.com/a?b#c",
      "https://Example.COM:443/",
      "http://example.com:80/x",
      "http://example.com:8080/x",
      "http://user:pass@example.com/x",
      "http://[::1]:3000/",
      "http://example.com?q=1",
      "http://example.com#frag",
    ]) {
      expect(origin(url)).toBe(new URL(url).origin)
    }
  })

  test("is empty for a URL that does not parse", () => {
    expect(originFor({ url: "/relative" })).toBe("")
  })

  test("stays right once more hosts than it remembers have been seen", () => {
    for (let i = 0; i < 100; i++) expect(origin(`http://h${i}.test/p`)).toBe(`http://h${i}.test`)
    expect(origin("http://h0.test/again")).toBe("http://h0.test")
  })
})
