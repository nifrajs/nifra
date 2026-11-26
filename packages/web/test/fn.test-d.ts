import type { StandardSchemaV1 } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"
import { type ServerFnReference, serverFn } from "../src/fn.ts"

/**
 * Type-level regression for the two calls the docs teach.
 *
 * `ServerFn` described the SERVER value - `(input, context)` - but the client imports a generated stub
 * that takes one argument, and `useServerFn` accepts `(input) => …`. So both documented calls were a
 * compile error while the docs said otherwise. This file fails to typecheck if that returns.
 *
 * It also pins the output link: the caller's type is the `output` schema's OUTPUT, and what the function
 * returns must fit the schema's INPUT, so a field the schema drops is not in the type the browser gets.
 */

const addTodo = serverFn(
  {
    input: t.object({ text: t.string({ minLength: 1 }) }),
    output: t.object({ id: t.string(), text: t.string() }),
  },
  async ({ text }) => ({ id: "1", text }),
)

// 1. A source declaration is a server value: omitting its required Context is rejected.
// @ts-expect-error direct server calls must pass the request Context
export const invalidDirect = async () => addTodo({ text: "hi" })

// 2. Handing it to a binding whose parameter is `(input) => Promise<Output>`.
export const asHookArg: ServerFnReference<{ text: string }, { id: string; text: string }> = addTodo

// 3. The server half still passes context, and the declaration still receives it typed.
export const withContext = serverFn(
  { input: t.object({ a: t.string() }), output: t.object({ a: t.string(), method: t.string() }) },
  async ({ a }, c) => ({ a, method: c.req.method }),
)

// 4. The caller sees the schema's output, not the function's return: `secret` is dropped, so it is not there.
const narrowed = serverFn({ output: t.object({ id: t.string() }) }, async () => ({
  id: "1",
  secret: "dropped by the output schema",
}))
type Narrowed = Awaited<ReturnType<typeof narrowed>>
export const visible: Narrowed = { id: "1" }
// @ts-expect-error `secret` is not in the type the browser gets
export const hidden: Narrowed["secret"] = "x"

// 5. A return that does not fit the output schema is a compile error.
const idSchema = t.object({ id: t.string() })
const wrongReturn = async () => ({ id: 1 })
// @ts-expect-error `id` must be a string
export const wrongShape = serverFn({ output: idSchema }, wrongReturn)

// 6. Returning data without an `output` schema is refused at run time, so it is refused here.
// @ts-expect-error no output schema: a function that returns data needs one
export const undeclared = serverFn({}, async () => ({ ok: true }))

// 7. Nothing to return needs no schema.
export const fireAndForget = serverFn({ input: t.object({ id: t.string() }) }, async () => {})

// 8. A direct call returns what the function returned; the browser gets what the schema makes of it.
const toNumber: StandardSchemaV1<string, number> = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value: Number(value) }) },
}
const counted = serverFn({ output: toNumber }, async () => "7")
export const directResult: Awaited<ReturnType<typeof counted>> = "7"
export const browserView: ServerFnReference<void, number> = counted
// @ts-expect-error the browser gets a number, not the string the function returned
export const wrongView: ServerFnReference<void, string> = counted

// 9. A redirect or an error response is control flow, so it needs no schema and passes one.
export const refused = serverFn({}, async () => new Response(null, { status: 403 }))
export const mixedRefusal = serverFn(
  { input: t.object({ flag: t.boolean() }) },
  async ({ flag }): Promise<void | Response> => {
    if (flag) return new Response(null, { status: 403 })
  },
)
export const refusedWithOutput = serverFn(
  { output: idSchema },
  async () => new Response(null, { status: 403 }),
)
