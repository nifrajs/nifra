import { createHook } from "node:async_hooks"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const fixture = process.argv[2]
if (fixture === undefined) throw new Error("usage: node promise-audit.mjs <saved-fixture.js>")
const module = await import(pathToFileURL(resolve(fixture)).href)
const headers = {
  authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
  cookie: "theme=dark",
  origin: "https://app.example.com",
  "x-request-id": "bench-1",
}
const passthrough = {
  "~standard": { version: 1, vendor: "profile", validate: (value) => ({ value }) },
}
const cases = [
  ["driver-control", { fetch: () => new Response(null) }, () => new Request("http://bench/")],
  ["driver-json", { fetch: () => Response.json({ ok: true }) }, () => new Request("http://bench/")],
  ...["auth-before-validation", "validate-before-auth"].flatMap((validationOrder) =>
    [false, true].map((asyncValidation) => [
      `${validationOrder}-${asyncValidation ? "async-query" : "sync"}`,
      module.makeWorstNifraApp(true).get(
        "/diagnostic",
        {
          validationOrder,
          query: {
            "~standard": {
              version: 1,
              vendor: "profile",
              validate(value) {
                const result = { value }
                return asyncValidation ? Promise.resolve(result) : result
              },
            },
          },
        },
        (c) => c.query,
      ),
      () =>
        new Request("http://bench/diagnostic?trace=abc", { headers: { "x-req-id": "bench-1" } }),
    ]),
  ),
  ...["auth-before-validation", "validate-before-auth"].map((validationOrder) => [
    `authenticated-${validationOrder}-async-query`,
    module
      .makeWorstNifraApp(true)
      .authenticate({
        id: "probe",
        run: () => ({ kind: "authenticated", principal: { id: "reader" } }),
      })
      .get(
        "/diagnostic",
        {
          validationOrder,
          query: {
            "~standard": {
              version: 1,
              vendor: "profile",
              validate: (value) => Promise.resolve({ value }),
            },
          },
        },
        (c) => c.query,
      ),
    () => new Request("http://bench/diagnostic?trace=abc", { headers: { "x-req-id": "bench-1" } }),
  ]),
  ...["auth-before-validation", "validate-before-auth"].flatMap((validationOrder) => [
    [
      `${validationOrder}-async-derive`,
      module
        .makeWorstNifraApp(true)
        .derive(async () => ({ resumed: true }))
        .get("/diagnostic", { validationOrder }, () => ({ ok: true })),
      () => new Request("http://bench/diagnostic", { headers: { "x-req-id": "bench-1" } }),
    ],
    [
      `${validationOrder}-body-async-handler`,
      module
        .makeWorstNifraApp(true)
        .post("/diagnostic", { validationOrder, body: passthrough }, async (c) => c.body),
      () =>
        new Request("http://bench/diagnostic", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"ok":true}',
        }),
    ],
  ]),
  [
    "realworld-get",
    module.makeNifraApp(),
    () => new Request("http://bench/api/orders?limit=10", { headers }),
  ],
  ...[false, true].flatMap((generic) => [
    [
      `${generic ? "generic" : "closed"}-get`,
      module.makeWorstNifraApp(generic),
      () =>
        new Request("http://bench/orgs/acme/projects/apollo/tasks/42?verbose=1&trace=abc123", {
          headers: { "x-req-id": "bench-1" },
        }),
    ],
    [
      `${generic ? "generic" : "closed"}-post`,
      module.makeWorstNifraApp(generic),
      () =>
        new Request("http://bench/orgs/acme/projects/apollo/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: [{ title: "x", done: false, priority: 1, notes: "x" }] }),
        }),
    ],
  ]),
]
const result = {}
for (const [name, app, makeRequest] of cases) {
  for (let i = 0; i < 200; i++) {
    const response = await app.fetch(makeRequest())
    if (response.status !== 200) throw new Error(`${name}: warmup failed`)
  }
  let promises = 0
  const hook = createHook({
    init(_id, type) {
      if (type === "PROMISE") promises++
    },
  })
  for (let i = 0; i < 100; i++) {
    // Request construction stays outside the instrumented interval; the await driver stays inside.
    const request = makeRequest()
    try {
      hook.enable()
      const response = await app.fetch(request)
      if (response.status !== 200) throw new Error(`${name}: measured request failed`)
    } finally {
      hook.disable()
    }
  }
  result[name] = promises / 100
}
console.log(
  JSON.stringify({
    node: process.version,
    scope:
      "PROMISE init events/request including await driver; POST uses delivered-byte bounded reader",
    warmup: 200,
    samples: 100,
    result,
  }),
)
