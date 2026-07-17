/**
 * Runtime response-contract assertion for the in-process test client
 * (`testClient(app, { validateResponses: true })`).
 *
 * The `response` / `errors` schemas on a route are a compile-time contract on the handler; nothing
 * re-checks the bytes that actually leave the app. This wrapper closes that gap in tests: every
 * JSON response is validated against the route's declared schema for its status - `response` for
 * 2xx, `errors[status]` for declared failures - and a mismatch THROWS (failing the test loudly)
 * instead of letting a drifted payload pass. Responses with no declared schema for their status,
 * non-JSON bodies (SSE, streams, HTML), and 204/205/HEAD are passed through untouched.
 *
 * Route lookup reuses the framework's own `Router` over `app.routes()`, so pattern matching can
 * never drift from what the server itself does.
 */

import { type Method, Router } from "@nifrajs/core/router"
import type { FetchFn } from "./client.ts"

/** The slice of a Standard Schema this wrapper runs. */
interface SchemaLike {
  readonly "~standard": {
    readonly validate: (value: unknown) =>
      | { readonly issues?: ReadonlyArray<IssueLike> | undefined; readonly value?: unknown }
      | Promise<{
          readonly issues?: ReadonlyArray<IssueLike> | undefined
          readonly value?: unknown
        }>
  }
}

interface IssueLike {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

interface RouteSchemaLike {
  readonly response?: SchemaLike
  readonly errors?: Readonly<Record<number, SchemaLike>>
}

interface RouteDescriptorLike {
  readonly method: string
  readonly path: string
  readonly schema: RouteSchemaLike | undefined
}

/** What `validateResponses` needs from the app beyond `fetch`: the route table. */
export interface RouteIntrospectable {
  routes(): ReadonlyArray<RouteDescriptorLike>
}

/**
 * A response body that broke its route's declared contract. Thrown THROUGH the "never throws"
 * client on purpose: this is a test assertion about the server's honesty, not a call outcome the
 * caller should branch on - swallowing it into a `Result` would let the drift pass the test.
 */
export class ResponseContractViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResponseContractViolation"
  }
}

function formatIssues(issues: ReadonlyArray<IssueLike>): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((seg) => String(typeof seg === "object" && seg !== null ? seg.key : seg))
        .join(".")
      return path === "" ? issue.message : `${path}: ${issue.message}`
    })
    .join("; ")
}

/**
 * Wrap the in-process bridge so every response is checked against its route's declared contract.
 * Throws at wrap time when the app cannot enumerate routes - a misconfiguration, not a soft skip.
 */
export function withResponseValidation(app: unknown, bridge: FetchFn): FetchFn {
  const routesOf = (app as Partial<RouteIntrospectable>).routes
  if (typeof routesOf !== "function") {
    throw new Error(
      "validateResponses needs an app that exposes .routes() (a nifra server); this app does not",
    )
  }
  // One router per client, built once: match by the server's own engine, payload = the schema.
  const router = new Router<RouteSchemaLike | undefined>()
  for (const route of routesOf.call(app)) {
    router.add(route.method as Method, route.path, route.schema)
  }

  return async (url, init) => {
    const response = await bridge(url, init)
    const method = (init?.method ?? "GET").toUpperCase()
    const status = response.status
    if (method === "HEAD" || status === 204 || status === 205) return response

    const match = router.find(method, new URL(url).pathname)
    if (!match.found) return response
    const schema = match.payload
    const declared = status >= 200 && status < 300 ? schema?.response : schema?.errors?.[status]
    if (declared === undefined) return response

    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("application/json")) return response
    // Clone so the caller still gets an unconsumed body; unparseable JSON is the transport's problem.
    let body: unknown
    try {
      body = await response.clone().json()
    } catch {
      return response
    }
    const result = await declared["~standard"].validate(body)
    if (result.issues !== undefined) {
      throw new ResponseContractViolation(
        `response contract violation: ${method} ${new URL(url).pathname} → ${status}: ${formatIssues(result.issues)}`,
      )
    }
    return response
  }
}
