import { describe, expect, test } from "bun:test"
import { cookieJar } from "../src/index.ts"

/** A response-like carrying the given Set-Cookie header(s). */
function withSetCookie(...values: string[]): { headers: Headers } {
  const headers = new Headers()
  for (const value of values) headers.append("set-cookie", value)
  return { headers }
}

describe("cookieJar", () => {
  test("stores Set-Cookie (ignoring attributes) and emits a Cookie header", () => {
    const jar = cookieJar()
    jar.store(withSetCookie("sid=abc; Path=/; HttpOnly", "theme=dark"))
    expect(jar.get("sid")).toBe("abc")
    expect(jar.get("theme")).toBe("dark")
    expect(jar.header()).toBe("sid=abc; theme=dark")
    expect(jar.size).toBe(2)
  })

  test("applyTo sets the Cookie header only when the jar is non-empty", () => {
    const jar = cookieJar()
    const empty = new Headers()
    jar.applyTo(empty)
    expect(empty.get("cookie")).toBeNull()

    jar.set("a", "1")
    const headers = new Headers()
    jar.applyTo(headers)
    expect(headers.get("cookie")).toBe("a=1")
  })

  test("Max-Age=0 and a past Expires remove a cookie (logout)", () => {
    const jar = cookieJar()
    jar.set("sid", "abc")
    jar.store(withSetCookie("sid=; Max-Age=0"))
    expect(jar.get("sid")).toBeUndefined()

    jar.set("t", "x")
    jar.store(withSetCookie("t=; Expires=Thu, 01 Jan 1970 00:00:00 GMT"))
    expect(jar.get("t")).toBeUndefined()
  })

  test("a later Set-Cookie overwrites; clear empties the jar", () => {
    const jar = cookieJar()
    jar.store(withSetCookie("sid=one"))
    jar.store(withSetCookie("sid=two"))
    expect(jar.get("sid")).toBe("two")
    jar.clear()
    expect(jar.size).toBe(0)
  })
})
