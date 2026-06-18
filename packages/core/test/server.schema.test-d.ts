/**
 * Type-level contract for schema-driven body/query inference. Verified by `tsc`.
 */
import type { Equal, Expect } from "@nifrajs/test-utils"
import type { StandardSchemaV1 } from "../src/schema/standard.ts"
import type { Context, RouteSchema } from "../src/server/context.ts"

type BodySchema = { body: StandardSchemaV1<unknown, { name: string }> }
type QuerySchema = { query: StandardSchemaV1<unknown, { page: number }> }

// With a body schema, c.body is the schema's validated output.
export type _Body = Expect<Equal<Context<"/x", BodySchema>["body"], { name: string }>>

// With a query schema, c.query is the schema's validated output.
export type _Query = Expect<Equal<Context<"/x", QuerySchema>["query"], { page: number }>>

// Without schemas, body is undefined and query is raw URLSearchParams.
export type _NoBody = Expect<Equal<Context<"/x">["body"], undefined>>
export type _NoQuery = Expect<Equal<Context<"/x">["query"], URLSearchParams>>

// Params still come from the path independently of the schema.
export type _ParamsWithSchema = Expect<
  Equal<Context<"/u/:id", BodySchema & RouteSchema>["params"], { id: string }>
>
