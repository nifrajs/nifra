import { t } from "@nifrajs/schema"
import { type ServerFnReference, serverFn } from "../src/fn.ts"

/**
 * Type-level regression for the two calls the docs teach.
 *
 * `ServerFn` described the SERVER value - `(input, context)` - but the client imports a generated stub
 * that takes one argument, and `useServerFn` accepts `(input) => …`. So both documented calls were a
 * compile error while the docs said otherwise. This file fails to typecheck if that returns.
 */

const addTodo = serverFn(
  { input: t.object({ text: t.string({ minLength: 1 }) }) },
  async ({ text }) => ({ id: "1", text }),
)

// 1. A source declaration is a server value: omitting its required Context is rejected.
// @ts-expect-error direct server calls must pass the request Context
export const invalidDirect = async () => addTodo({ text: "hi" })

// 2. Handing it to a binding whose parameter is `(input) => Promise<Output>`.
export const asHookArg: ServerFnReference<{ text: string }, { id: string; text: string }> = addTodo

// 3. The server half still passes context, and the declaration still receives it typed.
export const withContext = serverFn({ input: t.object({ a: t.string() }) }, async ({ a }, c) => ({
  a,
  method: c.req.method,
}))
