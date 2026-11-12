import { expect, test } from "bun:test"
import {
  finishRequestHeaderTrackingInPlace,
  markRequestHeaderDependent,
  requestHeadersWereRead,
  trackRequestHeaderReads,
  trackRequestHeaderReadsInPlace,
} from "../src/internal/request-header-tracker.ts"

test("tracks standard header methods and clones that preserve the dependency state", () => {
  const request = trackRequestHeaderReads(
    new Request("https://nifra.invalid/", { headers: { "accept-language": "en" } }),
  )
  expect(requestHeadersWereRead(request)).toBe(false)
  expect(trackRequestHeaderReads(request)).toBe(request)
  expect(request.headers.get("accept-language")).toBe("en")
  expect(requestHeadersWereRead(request)).toBe(true)

  const clone = request.clone()
  expect(clone.headers.has("accept-language")).toBe(true)
  expect(requestHeadersWereRead(clone)).toBe(true)
})

test("explicit request handoff taint covers native Request copies", () => {
  const request = trackRequestHeaderReads(
    new Request("https://nifra.invalid/", { headers: { "accept-language": "en" } }),
  )
  const copy = new Request(request)

  expect(copy.headers.get("accept-language")).toBe("en")

  markRequestHeaderDependent(request)
  expect(requestHeadersWereRead(request)).toBe(true)
})

test("does not let a native Headers prototype call bypass the tracked view", () => {
  const request = trackRequestHeaderReads(
    new Request("https://nifra.invalid/", { headers: { "accept-language": "en" } }),
  )

  expect(() => Headers.prototype.get.call(request.headers, "accept-language")).toThrow()
  expect(requestHeadersWereRead(request)).toBe(false)
})

test("snapshots middleware reads and restores native headers before framework work", () => {
  const request = new Request("https://nifra.invalid/", {
    headers: { "accept-language": "en" },
  })
  trackRequestHeaderReadsInPlace(request)
  expect(request.headers.get("accept-language")).toBe("en")
  finishRequestHeaderTrackingInPlace(request)

  expect(requestHeadersWereRead(request)).toBe(true)
  expect(request.headers.get("x-nifra-internal-check")).toBeNull()
})

test("framework header reads after the middleware snapshot do not disable owner caching", () => {
  const request = new Request("https://nifra.invalid/", {
    headers: { "accept-language": "en" },
  })
  trackRequestHeaderReadsInPlace(request)
  finishRequestHeaderTrackingInPlace(request)

  expect(request.headers.get("accept-language")).toBe("en")
  expect(requestHeadersWereRead(request)).toBe(false)
})

test("fails closed when the request view cannot be cloned or is unknown", async () => {
  const consumed = new Request("https://nifra.invalid/", { method: "POST", body: "used" })
  await consumed.text()
  expect(trackRequestHeaderReads(consumed)).toBe(consumed)
  expect(requestHeadersWereRead(consumed)).toBe(true)

  const observedBeforeRoute = new Request("https://nifra.invalid/", {
    method: "POST",
    body: "used",
  })
  trackRequestHeaderReadsInPlace(observedBeforeRoute)
  finishRequestHeaderTrackingInPlace(observedBeforeRoute)
  await observedBeforeRoute.text()
  expect(trackRequestHeaderReads(observedBeforeRoute)).toBe(observedBeforeRoute)
  expect(requestHeadersWereRead(observedBeforeRoute)).toBe(true)
  expect(requestHeadersWereRead(new Request("https://nifra.invalid/"))).toBe(true)
})

test("fails closed when the runtime request view cannot be inspected in place", () => {
  const request = new Proxy(new Request("https://nifra.invalid/"), {
    get(target, property) {
      if (property === "headers") throw new TypeError("headers unavailable")
      return Reflect.get(target, property, target)
    },
  })

  trackRequestHeaderReadsInPlace(request)

  expect(requestHeadersWereRead(request)).toBe(true)
})
