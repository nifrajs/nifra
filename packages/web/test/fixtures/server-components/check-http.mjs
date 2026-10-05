import assert from "node:assert/strict"
import { readComponentFrames } from "../../../dist/server-components/frames.js"

const origin = process.env.NIFRA_COMPONENT_URL
assert.ok(origin, "NIFRA_COMPONENT_URL is required")
const documentA = await fetch(origin)
assert.equal(documentA.status, 200)
assert.equal(documentA.headers.get("cache-control"), "private, no-store")
const html = await documentA.text()
const match = /<script id="component-state" type="application\/json">([^<]+)<\/script>/.exec(html)
assert.ok(match, "exact SSR state must be present")
const state = JSON.parse(match[1])
for (const path of [
  "/_worker.js",
  "/server/index.js",
  "/ssr/index.js",
  "/rsc/index.js",
  "/component-manifest.json",
]) {
  const response = await fetch(new URL(path, origin))
  assert.ok(
    [403, 404].includes(response.status),
    `Private build artifact ${path} must not be served`,
  )
}
const record = state.records[0]
assert.ok(record && state.records.length === 2)
const request = {
  v: 1,
  build: state.build,
  reference: record.reference,
  key: record.key,
  parent: record.parent,
  input: record.input,
  generation: 1,
  routeEpoch: 0,
  authEpoch: 0,
}
const headers = {
  "x-nifra-component": Buffer.from(JSON.stringify(request)).toString("base64url"),
  "sec-fetch-site": "same-origin",
}
const refreshed = await fetch(new URL("?revision=new", origin), { headers })
assert.equal(refreshed.status, 200)
assert.equal(refreshed.headers.get("cache-control"), "private, no-store")
assert.equal(refreshed.headers.get("content-type"), "application/vnd.nifra.component-v1")
const frames = await readComponentFrames(refreshed.body, AbortSignal.timeout(15000))
assert.equal(frames.value.build, state.build)
assert.equal(frames.value.records.length, 2)
assert.match(frames.value.records[0].html.replace(/<!--[\s\S]*?-->/g, ""), /Revision 2/)
const userB = await fetch(origin, { headers: { cookie: "fixture-subject=B" } })
assert.equal(userB.headers.get("cache-control"), "private, no-store")
const htmlB = await userB.text()
assert.match(htmlB, /B title/)
assert.doesNotMatch(await (await fetch(origin)).text(), /B title/)
const data = await fetch(origin, { headers: { "x-nifra-data": "1" } })
assert.equal(data.headers.get("cache-control"), "private, no-store")
assert.ok((await data.json()).serverComponents)
for (const [query, changed, expected] of [
  ["?deny=yes", {}, 403],
  ["", { "x-nifra-data": "1" }, 400],
  ["", { "sec-fetch-site": "cross-site" }, 403],
  [
    "",
    {
      "x-nifra-component": Buffer.from(
        JSON.stringify({ ...request, reference: "foreign" }),
      ).toString("base64url"),
    },
    404,
  ],
  [
    "",
    {
      "x-nifra-component": Buffer.from(JSON.stringify({ ...request, build: "old" })).toString(
        "base64url",
      ),
    },
    409,
  ],
]) {
  const response = await fetch(new URL(query, origin), { headers: { ...headers, ...changed } })
  assert.equal(response.status, expected)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  const body = await response.text()
  assert.doesNotMatch(body, /B title|fabricated-private|SECRET_COMPONENT_SENTINEL/)
}
const interrupted = new AbortController()
const pending = fetch(new URL("?delay=slow", origin), { headers, signal: interrupted.signal })
interrupted.abort()
await assert.rejects(pending)
const mutation = await fetch(new URL("/_nifra/fn/actions/save", origin), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ fail: false }),
})
assert.equal(mutation.status, 200)
assert.deepEqual(await mutation.json(), { ok: true })
const progressive = await fetch(origin, {
  method: "POST",
  body: new URLSearchParams({ fail: "no" }),
})
assert.equal(progressive.status, 200)
assert.match((await progressive.text()).replace(/<!--[\s\S]*?-->/g, ""), /Revision 3/)
console.log(
  JSON.stringify({
    adapter: state.adapter,
    build: state.build,
    target: process.env.NIFRA_COMPONENT_TARGET,
    status: "passed",
    cases: [
      "initial",
      "refresh",
      "header-proxy",
      "private-A-B",
      "data-mode",
      "denial",
      "foreign-ref",
      "generation",
      "abort",
      "serverFn",
      "progressive",
    ],
  }),
)
