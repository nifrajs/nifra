/**
 * Fastify peer for the mixed-route Node stress workload.
 *
 * The route graph, hooks, validation shapes, response fields, dynamic headers, and direct Node
 * ingress intentionally match the Nifra/Elysia worst-case servers. Fastify's JSON Schema validator
 * is its normal production path; this file is a benchmark peer, not a second Nifra adapter.
 *
 *   node bench/http/worst-case/serve-node-fastify.ts <port>
 */
import Fastify from "fastify"

const port = Number(process.argv[2])
if (!Number.isInteger(port)) {
  throw new Error("usage: node bench/http/worst-case/serve-node-fastify.ts <port>")
}

const app = Fastify({ logger: false })

app.get("/health", () => ({ ok: true }))

// Fastify's request object is the per-request context for the same derive value used by the
// Nifra/Elysia peers. The hook is deliberately read-only and does not inspect request bodies.
app.addHook("onRequest", (request, _reply, done) => {
  const value = request.headers["x-req-id"]
  request.requestId = typeof value === "string" ? value : "none"
  done()
})

// Equivalent short-circuit behavior: blocked requests never reach route validation or handlers.
app.addHook("preHandler", (_request, reply, done) => {
  if (_request.headers["x-block"] === "1") {
    reply.code(403).send({ error: "blocked" })
    return
  }
  done()
})

// The Nifra/Elysia workloads include an after hook that observes and returns the current result.
// Fastify's onSend hook preserves the same no-op result transform for the serialized payload.
app.addHook("onSend", (_request, _reply, payload, done) => done(null, payload))

app.get<{
  Params: { org: string; proj: string; id: string }
  Querystring: { verbose: string; trace: string }
}>(
  "/orgs/:org/projects/:proj/tasks/:id",
  {
    schema: {
      querystring: {
        type: "object",
        required: ["verbose", "trace"],
        additionalProperties: false,
        properties: { verbose: { type: "string" }, trace: { type: "string" } },
      },
    },
  },
  (request, reply) => {
    reply.header("x-request-id", request.requestId)
    reply.header("x-trace", request.query.trace)
    return {
      org: request.params.org,
      proj: request.params.proj,
      id: request.params.id,
      verbose: request.query.verbose,
    }
  },
)

app.post<{
  Params: { org: string; proj: string }
  Body: {
    items: Array<{ title: string; done: boolean; priority: number; notes: string }>
  }
}>(
  "/orgs/:org/projects/:proj/tasks",
  {
    schema: {
      body: {
        type: "object",
        required: ["items"],
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["title", "done", "priority", "notes"],
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                done: { type: "boolean" },
                priority: { type: "number" },
                notes: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
  (request, reply) => {
    reply.header("x-request-id", request.requestId)
    reply.header("x-count", String(request.body.items.length))
    return {
      org: request.params.org,
      proj: request.params.proj,
      count: request.body.items.length,
      first: request.body.items[0]?.title ?? "",
    }
  },
)

await app.listen({ port, host: "127.0.0.1" })

declare module "fastify" {
  interface FastifyRequest {
    requestId: string
  }
}
