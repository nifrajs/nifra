import { expect, test } from "bun:test"
import {
  CLIENT_BATCH_MAX_EVENTS,
  devClientSource,
  devClientTag,
  injectIntoHtml,
  injectIntoStream,
  isInjectablePage,
  parseClientBatch,
  scriptHash,
} from "../src/dev-client.ts"

const TAG = "<script>x</script>"
const ORIGIN = "http://127.0.0.1:3000"
const config = { ingestPath: "/__nifra/client-event", pageToken: "t".repeat(43) }

const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

const bytesOf = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer())

test("the script goes after <head>, or after a <meta charset> that leads it", () => {
  expect(injectIntoHtml("<html><head><title>a</title></head>", TAG)).toBe(
    `<html><head>${TAG}<title>a</title></head>`,
  )
  expect(injectIntoHtml(`<head lang="en"><meta charset="utf-8"><title>a</title>`, TAG)).toBe(
    `<head lang="en"><meta charset="utf-8">${TAG}<title>a</title>`,
  )
  // A later meta is not the charset declaration the browser's prescan needs first.
  expect(injectIntoHtml(`<head><title>a</title><meta charset="utf-8">`, TAG)).toBe(
    `<head>${TAG}<title>a</title><meta charset="utf-8">`,
  )
  expect(injectIntoHtml("<header>not a head</header>", TAG)).toBe("<header>not a head</header>")
  expect(injectIntoHtml("<div>fragment</div>", TAG)).toBe("<div>fragment</div>")
})

test("streaming: the insertion survives tags split across chunks, and the rest streams untouched", async () => {
  const out = await bytesOf(
    injectIntoStream(
      streamOf("<!doctype html><he", "ad><meta char", 'set="utf-8">', "<p>é</p>"),
      TAG,
    ),
  )
  expect(new TextDecoder().decode(out)).toBe(
    `<!doctype html><head><meta charset="utf-8">${TAG}<p>é</p>`,
  )
  // A multi-byte character split across chunks must not be re-encoded into replacement characters.
  const encoded = new TextEncoder().encode("<head><title>日本</title></head>")
  const split = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.subarray(0, 15))
      controller.enqueue(encoded.subarray(15))
      controller.close()
    },
  })
  expect(new TextDecoder().decode(await bytesOf(injectIntoStream(split, TAG)))).toBe(
    `<head>${TAG}<title>日本</title></head>`,
  )
})

test("streaming: a head-less body passes through byte for byte", async () => {
  const body = `<div>${"x".repeat(70_000)}</div>`
  const out = await bytesOf(
    injectIntoStream(streamOf(body.slice(0, 30_000), body.slice(30_000)), TAG),
  )
  expect(new TextDecoder().decode(out)).toBe(body)
})

test("only HTML pages with a plain body are injectable", () => {
  const html = (init: ResponseInit = {}): Response =>
    new Response("<head></head>", {
      ...init,
      headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
    })
  expect(isInjectablePage(html(), "GET")).toBe(true)
  expect(isInjectablePage(html(), "HEAD")).toBe(false)
  expect(isInjectablePage(html({ headers: { "content-encoding": "gzip" } }), "GET")).toBe(false)
  expect(isInjectablePage(Response.json({}), "GET")).toBe(false)
  expect(isInjectablePage(new Response(null, { status: 204 }), "GET")).toBe(false)
})

test("CSP: a hash where the page counts hashes, nothing where it allows inline, no script where it allows none", () => {
  const source = devClientSource(config)
  const hash = scriptHash(source)

  const none = new Headers()
  expect(devClientTag(config, none, ORIGIN)).toBe(`<script data-nifra-dev>${source}</script>`)
  expect([...none.keys()]).toEqual([])

  const strict = new Headers({
    "content-security-policy": "default-src 'self'; script-src 'nonce-abc' 'strict-dynamic'",
  })
  expect(devClientTag(config, strict, ORIGIN)).toBeDefined()
  expect(strict.get("content-security-policy")).toBe(
    `default-src 'self'; script-src 'nonce-abc' 'strict-dynamic' ${hash}`,
  )

  // Adding a hash would switch 'unsafe-inline' off for the page's own inline scripts.
  const inline = new Headers({ "content-security-policy": "script-src 'self' 'unsafe-inline'" })
  devClientTag(config, inline, ORIGIN)
  expect(inline.get("content-security-policy")).toBe("script-src 'self' 'unsafe-inline'")

  const noScripts = new Headers({ "content-security-policy": "script-src 'none'" })
  expect(devClientTag(config, noScripts, ORIGIN)).toBeUndefined()
  expect(noScripts.get("content-security-policy")).toBe("script-src 'none'")

  // Without the hash the caller nonces the script itself (the Vite pipeline).
  const nonced = new Headers({ "content-security-policy": "script-src 'nonce-abc'" })
  devClientTag(config, nonced, ORIGIN, true)
  expect(nonced.get("content-security-policy")).toBe("script-src 'nonce-abc'")
})

test("CSP: the ingest URL is admitted where connect-src would refuse it", () => {
  const ingest = `${ORIGIN}/__nifra/client-event`
  const hash = scriptHash(devClientSource(config))
  const narrow = new Headers({
    "content-security-policy": "default-src 'self'; connect-src https://api.example.com",
    "content-security-policy-report-only": "connect-src 'none'",
  })
  devClientTag(config, narrow, ORIGIN)
  // default-src governs scripts here too, so it gains the hash; connect-src gains the ingest URL.
  expect(narrow.get("content-security-policy")).toBe(
    `default-src 'self' ${hash}; connect-src https://api.example.com ${ingest}`,
  )
  expect(narrow.get("content-security-policy-report-only")).toBe(`connect-src ${ingest}`)

  const self = new Headers({ "content-security-policy": "default-src 'self'" })
  devClientTag(config, self, ORIGIN)
  expect(self.get("content-security-policy")).toBe(`default-src 'self' ${hash}`)
})

test("config values cannot close the script element", () => {
  const source = devClientSource({
    ...config,
    requestId: "r1",
    documentPath: "/search?q=</script><script>alert(1)</script>",
  })
  expect(source).not.toContain("</script>")
  expect(source).toContain("\\u003c/script\\u003e")
})

test("a batch is validated field by field; junk events are dropped, oversized batches refused", () => {
  const batch = parseClientBatch({
    token: "abc",
    events: [
      { kind: "error", name: "TypeError", message: "x is undefined", stack: "at a:1:1", page: "/" },
      { kind: "console", level: "warn", message: "careful", page: "/a", requestId: "r12" },
      { kind: "console", level: "shout", message: "nope", page: "/" },
      { kind: "resource", tag: "script", url: "/x.js", page: "/", requestId: "not-an-id" },
      { kind: "error", message: "no page" },
      "string",
    ],
  })
  expect(batch?.events).toEqual([
    {
      kind: "error",
      name: "TypeError",
      message: "x is undefined",
      stack: "at a:1:1",
      page: "/",
      requestId: undefined,
    },
    { kind: "console", level: "warn", message: "careful", page: "/a", requestId: "r12" },
    { kind: "resource", tag: "script", url: "/x.js", page: "/", requestId: undefined },
  ])
  expect(parseClientBatch({ token: 1, events: [] })).toBeUndefined()
  expect(
    parseClientBatch({
      token: "abc",
      events: Array.from({ length: CLIENT_BATCH_MAX_EVENTS + 1 }, () => ({})),
    }),
  ).toBeUndefined()
  const long = parseClientBatch({
    token: "abc",
    events: [{ kind: "console", level: "log", message: "x".repeat(20_000), page: "/" }],
  })
  const [event] = long?.events ?? []
  expect(event?.kind === "console" ? event.message.length : 0).toBe(8 * 1024)
})
