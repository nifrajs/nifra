/**
 * The Elysia WORST-CASE app - shared by the Bun, Node, and Deno servers (only the adapter
 * option differs per runtime), serving IDENTICAL routes + semantics to _app.ts:
 * derive + before/after hooks, multi-param path, validated query, JSON body validation
 * (TypeBox, Elysia's idiomatic compiled lane, AOT ON - the default), and per-request
 * dynamic `set.headers` writes.
 */
import { Elysia, t } from "elysia"

export function makeWorstElysiaApp(options?: ConstructorParameters<typeof Elysia>[0]) {
  return (
    new Elysia(options)
      // Readiness probe only - defined BEFORE the hooks so it stays hook-free; never benched.
      .get("/health", () => ({ ok: true }))
      .derive(({ headers }) => ({ requestId: headers["x-req-id"] ?? "none" }))
      .onBeforeHandle(({ headers, set }) => {
        if (headers["x-block"] === "1") {
          set.status = 403
          return { error: "blocked" }
        }
        return undefined
      })
      .onAfterHandle(() => undefined)
      .get(
        "/orgs/:org/projects/:proj/tasks/:id",
        ({ params, query, requestId, set }) => {
          set.headers["x-request-id"] = requestId
          set.headers["x-trace"] = query.trace
          return { org: params.org, proj: params.proj, id: params.id, verbose: query.verbose }
        },
        { query: t.Object({ verbose: t.String(), trace: t.String() }) },
      )
      .post(
        "/orgs/:org/projects/:proj/tasks",
        ({ params, body, requestId, set }) => {
          set.headers["x-request-id"] = requestId
          set.headers["x-count"] = String(body.items.length)
          return {
            org: params.org,
            proj: params.proj,
            count: body.items.length,
            first: body.items[0]?.title ?? "",
          }
        },
        {
          body: t.Object({
            items: t.Array(
              t.Object({
                title: t.String(),
                done: t.Boolean(),
                priority: t.Number(),
                notes: t.String(),
              }),
            ),
          }),
        },
      )
  )
}
