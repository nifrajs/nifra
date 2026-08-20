/**
 * The GraphQL-over-HTTP transport - a plain Web `fetch` handler you mount at `POST /graphql` (and
 * optionally `GET /graphql`). It parses, validates, and executes against your `GraphQLSchema` using
 * `graphql`'s own `parse`/`validate`/`execute`; no server framework is re-bundled and no second HTTP
 * trust boundary is created - the request body is read through core's one bounded/proto-guarded lane
 * (`@nifrajs/core/edge-kit`'s {@link readBodyFramed}).
 *
 * Spec: https://graphql.github.io/graphql-over-http/draft/. POST carries `{query, operationName?,
 * variables?, extensions?}` as `application/json`; GET carries them as query-string params and may run
 * **queries only** (never a mutation) so it stays a safe, cacheable idempotent method. Responses use the
 * `application/graphql-response+json` media type with spec status codes by default; set
 * `legacyJsonResponse` for the old always-200 `application/json` shape older clients expect.
 *
 * PRIVACY: the handler never logs the query text, variables, or the request body. GraphQL documents are
 * user payloads; keeping them out of this package's output is the guardrail (a payload sink is an
 * operated concern, not a public-package one).
 */

import {
  EMPTY_RESPONSE_CONTROLS,
  type ProtoPoisoning,
  plainError,
  queryObjectOf,
  type ResponseResult,
  readBodyFramed,
  searchOf,
  toResponse,
} from "@nifrajs/core/edge-kit"
import {
  type DocumentNode,
  type ExecutionResult,
  execute,
  GraphQLError,
  type GraphQLSchema,
  getOperationAST,
  parse,
  Source,
  specifiedRules,
  validate,
} from "graphql"
import {
  buildContext,
  type GraphqlContextBuilder,
  type GraphqlContextInput,
  type NifraContextLike,
} from "./context.ts"

const DEFAULT_MAX_BODY_BYTES = 1_000_000
const GRAPHQL_RESPONSE_JSON = "application/graphql-response+json; charset=utf-8"
const JSON_UTF8 = "application/json; charset=utf-8"

const CORS_BASE: Record<string, string> = {
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
}

export interface GraphqlHttpOptions<Context = unknown, Env = unknown> {
  /** The executable schema (types + resolvers), e.g. from `graphql`'s `buildSchema` or a schema builder. */
  readonly schema: GraphQLSchema
  /** Build the resolver `contextValue` from the request (and nifra context when mounted). */
  readonly context?: GraphqlContextBuilder<Context, Env>
  /** The nifra route context, when the caller has one (supplied by `mountGraphql`). */
  readonly nifra?: NifraContextLike<Env>
  /** Maximum request body size in bytes. Default 1 MB. Rejected bodies answer 413. */
  readonly maxBodyBytes?: number
  /** Prototype-pollution policy for the parsed JSON body. Default `"reject"`. */
  readonly protoPoisoning?: ProtoPoisoning
  /** Optional root value passed to the executor. */
  readonly rootValue?: unknown
  /**
   * Origin allowlist for the CORS `access-control-allow-origin` header. Omit to reflect any origin
   * (`*`) - correct for a public API; set it to lock the browser callers down.
   */
  readonly allowedOrigins?: readonly string[]
  /**
   * Per-request authorization, run after the body parses and before execution. Return `false` to answer
   * `401` with a GraphQL error envelope and skip execution entirely.
   */
  readonly authorize?: (request: Request) => boolean | Promise<boolean>
  /** Emit the legacy always-200 `application/json` response shape instead of `application/graphql-response+json`. */
  readonly legacyJsonResponse?: boolean
}

/** A parsed GraphQL request payload (POST body or GET query string), before validation. */
interface GraphqlParams {
  readonly query: string
  readonly operationName: string | null
  readonly variables: Record<string, unknown> | null
}

function assertByteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("GraphQL maxBodyBytes must be a non-negative safe integer")
  }
}

function corsFor(
  request: Request,
  allowedOrigins: readonly string[] | undefined,
): Record<string, string> | null {
  if (allowedOrigins === undefined) return { ...CORS_BASE, "access-control-allow-origin": "*" }
  const origin = request.headers.get("origin")
  if (origin === null) return { ...CORS_BASE, vary: "Origin" }
  if (allowedOrigins.includes(origin)) {
    return { ...CORS_BASE, "access-control-allow-origin": origin, vary: "Origin" }
  }
  return null
}

/** Render a rejection from readBodyFramed - a `Response` passes through, a `ResponseResult` is rendered
 * through the same core renderer the full Server uses, so the wire bytes match. */
function render(r: Response | ResponseResult): Response {
  return r instanceof Response ? r : toResponse(r, EMPTY_RESPONSE_CONTROLS)
}

/** Serialize an execution/error payload to a JSON `Response` with the negotiated media type + status.
 * `payload` is any JSON-serializable GraphQL result (`{data?, errors?}`); GraphQLError values serialize
 * via their own `toJSON`. */
function graphqlResponse(
  payload: unknown,
  status: number,
  legacy: boolean,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    status: legacy ? 200 : status,
    headers: { "content-type": legacy ? JSON_UTF8 : GRAPHQL_RESPONSE_JSON, ...cors },
  })
}

/** A request-level (parse/validate/auth/method) failure: `{ errors: [...] }`, no `data` key. */
function requestError(
  message: string,
  status: number,
  legacy: boolean,
  cors: Record<string, string>,
  errors?: readonly GraphQLError[],
): Response {
  const payload = errors ?? [new GraphQLError(message)]
  return graphqlResponse({ errors: payload.map((e) => e.toJSON()) }, status, legacy, cors)
}

/** Coerce a `?variables=<json>` string (GET) into an object, or throw a GraphQLError on bad JSON. */
function parseVariables(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null || raw === "") return null
  if (typeof raw === "object") return raw as Record<string, unknown>
  if (typeof raw !== "string") throw new GraphQLError("Variables must be a JSON object.")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new GraphQLError("Variables are invalid JSON.")
  }
  if (parsed === null) return null
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GraphQLError("Variables must be a JSON object.")
  }
  return parsed as Record<string, unknown>
}

/** Read `{query, operationName, variables}` from a parsed POST body. Throws GraphQLError when malformed. */
function paramsFromBody(body: unknown): GraphqlParams {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new GraphQLError("POST body must be a JSON object.")
  }
  const b = body as Record<string, unknown>
  if (typeof b.query !== "string" || b.query.length === 0) {
    throw new GraphQLError("A `query` string is required.")
  }
  const operationName = typeof b.operationName === "string" ? b.operationName : null
  return { query: b.query, operationName, variables: parseVariables(b.variables) }
}

/** Read the same shape from a GET query string. */
function paramsFromQuery(query: Record<string, unknown>): GraphqlParams {
  const q = query.query
  if (typeof q !== "string" || q.length === 0)
    throw new GraphQLError("A `query` parameter is required.")
  const operationName = typeof query.operationName === "string" ? query.operationName : null
  return { query: q, operationName, variables: parseVariables(query.variables) }
}

/** Parse, validate, and execute one already-extracted GraphQL request. */
async function run<Context, Env>(
  params: GraphqlParams,
  request: Request,
  opts: GraphqlHttpOptions<Context, Env>,
  isGet: boolean,
  legacy: boolean,
  cors: Record<string, string>,
): Promise<Response> {
  let document: DocumentNode
  try {
    document = parse(new Source(params.query, "GraphQL request"))
  } catch (err) {
    const gqlErr = err instanceof GraphQLError ? err : new GraphQLError(String(err))
    return requestError("", 400, legacy, cors, [gqlErr])
  }

  const validationErrors = validate(opts.schema, document, specifiedRules)
  if (validationErrors.length > 0) {
    return requestError("", 400, legacy, cors, validationErrors)
  }

  // GET is idempotent and cacheable, so per the GraphQL-over-HTTP spec it may run queries only.
  const operationAst = getOperationAST(document, params.operationName ?? undefined)
  if (isGet && operationAst != null && operationAst.operation !== "query") {
    return requestError(
      "Only query operations may run over GET.",
      405,
      legacy,
      { ...cors, allow: "POST" },
      [new GraphQLError("Only query operations are allowed over GET.")],
    )
  }

  const contextInput: GraphqlContextInput<Env> =
    opts.nifra !== undefined ? { request, nifra: opts.nifra } : { request }
  let contextValue: Context
  try {
    contextValue = await buildContext(opts.context, contextInput)
  } catch (err) {
    const gqlErr =
      err instanceof GraphQLError ? err : new GraphQLError("Failed to build request context.")
    return graphqlResponse({ errors: [gqlErr.toJSON()] }, 500, legacy, cors)
  }

  let result: ExecutionResult
  try {
    result = (await execute({
      schema: opts.schema,
      document,
      rootValue: opts.rootValue,
      contextValue,
      variableValues: params.variables ?? undefined,
      operationName: params.operationName ?? undefined,
    })) as ExecutionResult
  } catch (err) {
    const gqlErr = err instanceof GraphQLError ? err : new GraphQLError("Execution failed.")
    return graphqlResponse({ errors: [gqlErr.toJSON()] }, 400, legacy, cors)
  }

  // Field/execution errors are a normal 200 result with both `data` and `errors`.
  return graphqlResponse(result, 200, legacy, cors)
}

/**
 * Handle one GraphQL HTTP request. Never throws - a malformed request becomes a GraphQL error envelope.
 * Mount it directly (`app.all('/graphql', (c) => respondGraphql(c.req, { schema }))`) or via
 * {@link mountGraphql}, which also wires the nifra context in.
 */
export async function respondGraphql<Context = unknown, Env = unknown>(
  request: Request,
  options: GraphqlHttpOptions<Context, Env>,
): Promise<Response> {
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  assertByteLimit(maxBytes)
  const legacy = options.legacyJsonResponse === true

  const cors = corsFor(request, options.allowedOrigins)
  if (cors === null) return new Response(null, { status: 403 })

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })

  if (options.authorize !== undefined) {
    const ok = await options.authorize(request)
    if (!ok) {
      return requestError("Unauthorized.", 401, legacy, cors, [new GraphQLError("Unauthorized.")])
    }
  }

  if (request.method === "GET") {
    let params: GraphqlParams
    try {
      params = paramsFromQuery(queryObjectOf(searchOf(request.url)) as Record<string, unknown>)
    } catch (err) {
      const gqlErr = err instanceof GraphQLError ? err : new GraphQLError(String(err))
      return requestError("", 400, legacy, cors, [gqlErr])
    }
    return run(params, request, options, true, legacy, cors)
  }

  if (request.method !== "POST") {
    return requestError("Method not allowed.", 405, legacy, { ...cors, allow: "GET, POST" }, [
      new GraphQLError("Only GET and POST are supported."),
    ])
  }

  // Read the JSON body through core's single bounded + proto-guarded framing lane.
  return readBodyFramed<Response>(
    request,
    maxBytes,
    options.protoPoisoning ?? "reject",
    async (parsed) => {
      let params: GraphqlParams
      try {
        params = paramsFromBody(parsed)
      } catch (err) {
        const gqlErr = err instanceof GraphQLError ? err : new GraphQLError(String(err))
        return requestError("", 400, legacy, cors, [gqlErr])
      }
      return run(params, request, options, false, legacy, cors)
    },
    (response: Response | ResponseResult) => {
      // readBodyFramed's own rejections (413 too-large, 415, proto-guard) - render + attach CORS.
      const res = render(response)
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
      return res
    },
    (err: unknown) => {
      // A body that failed to read (bad JSON / proto-guard) is a request error, not a crash.
      if (err instanceof Response) return err
      return requestError("Invalid request body.", 400, legacy, cors, [
        new GraphQLError("Request body could not be read as JSON."),
      ])
    },
  ).catch(() => plainErrorResponse(cors))
}

/** Last-resort framing fallback so the handler contract ("never throws") holds even on an edge-kit change. */
function plainErrorResponse(cors: Record<string, string>): Response {
  const res = render(plainError(400, "bad_request"))
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
  return res
}
