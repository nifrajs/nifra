/**
 * Built-in `t` schemas: validate at the request boundary, and generate OpenAPI for
 * free (a TypeBox schema is a JSON Schema).
 *
 *   bun run examples/schema-openapi.ts
 */
import { server } from "@nifrajs/core/server"
import { t, toOpenAPI } from "@nifrajs/schema"

const app = server().post(
  "/users",
  { body: t.object({ name: t.string(), age: t.integer() }) },
  (c) => ({ id: "u1", name: c.body.name, age: c.body.age }),
)

function post(body: unknown): Request {
  return new Request("http://localhost/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const ok = await app.fetch(post({ name: "Ada", age: 36 }))
console.log("valid   ->", ok.status, await ok.json()) // 200 { id, name, age }

const bad = await app.fetch(post({ name: "Ada", age: "old" }))
console.log("invalid ->", bad.status, await bad.json()) // 400 { ok: false, error: "validation", ... }

console.log("\nOpenAPI 3.1:")
console.log(JSON.stringify(toOpenAPI(app, { title: "Users API", version: "1.0.0" }), null, 2))
