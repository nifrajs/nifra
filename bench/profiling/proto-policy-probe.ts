import { Elysia, t } from "elysia"
import Fastify from "fastify"
import { server } from "../../packages/core/dist/server.js"
import { makeWorstNifraApp } from "../http/worst-case/_app.ts"
import { makeWorstElysiaApp } from "../http/worst-case/_elysia-app.ts"

// Behavioral probe, never a throughput measurement. Closed schemas may clean extra keys even
// when the parser accepts them; report parser passthrough and the benchmark route separately.
function inspect(value: unknown) {
  const object = value !== null && typeof value === "object"
  const ctorValue: unknown = object ? Reflect.get(value, "constructor") : undefined
  return {
    protoKey: object && Object.hasOwn(value, "__proto__"),
    constructorPrototype:
      object &&
      Object.hasOwn(value, "constructor") &&
      ctorValue !== null &&
      typeof ctorValue === "object" &&
      Object.hasOwn(ctorValue, "prototype"),
  }
}

const passthrough = {
  "~standard": {
    version: 1 as const,
    vendor: "nifra-proto-probe",
    validate: (value: unknown) => ({ value }),
  },
}
const nifra = server().post("/json", { body: passthrough }, (c) => inspect(c.body))
const elysia = new Elysia().post("/json", ({ body }) => inspect(body), { body: t.Any() })
const fastify = Fastify({ logger: false })
fastify.post("/json", (request) => inspect(request.body))
const worstNifra = makeWorstNifraApp(true)
const worstElysia = makeWorstElysiaApp(undefined, true)
const payloads = {
  clean: '{"name":"Ada"}',
  proto: '{"__proto__":{"admin":true},"name":"Ada"}',
  escaped: '{"\\u005f_proto__":{"admin":true}}',
  constructor: '{"constructor":{"prototype":{"admin":true}}}',
}
async function fetchProbe(
  handler: (request: Request) => Response | Promise<Response>,
  path: string,
  body: string,
) {
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(body).length),
      },
      body,
    }),
  )
  return { status: response.status, body: await response.json() }
}

const result: Record<string, unknown> = { runtime: Bun.version, passthrough: {}, benchmark: {} }
const parserResults: Record<string, unknown> = {}
try {
  for (const [name, body] of Object.entries(payloads)) {
    const f = await fastify.inject({
      method: "POST",
      url: "/json",
      headers: { "content-type": "application/json" },
      payload: body,
    })
    parserResults[name] = {
      nifra: await fetchProbe((r) => nifra.fetch(r), "/json", body),
      elysia: await fetchProbe((r) => elysia.fetch(r), "/json", body),
      fastify: { status: f.statusCode, body: f.json() },
    }
  }
  result.passthrough = parserResults
  const task = '{"title":"task-0","done":false,"priority":1,"notes":"ok"}'
  const body = `{"items":[${task}],"__proto__":{"admin":true}}`
  result.benchmark = {
    nifra: await fetchProbe((r) => worstNifra.fetch(r), "/orgs/acme/projects/apollo/tasks", body),
    elysia: await fetchProbe((r) => worstElysia.fetch(r), "/orgs/acme/projects/apollo/tasks", body),
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  await fastify.close()
}
