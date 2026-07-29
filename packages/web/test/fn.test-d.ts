import { t } from "@nifrajs/schema"
import { serverFn } from "../src/fn.ts"

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

// 1. Calling it the way a component does - one argument, as the client stub.
export const direct = async (): Promise<{ id: string; text: string }> => addTodo({ text: "hi" })

// 2. Handing it to a binding whose parameter is `(input) => Promise<Output>`.
type ServerFnArg<Input, Output> = (input: Input) => Promise<Output> | Output
export const asHookArg: ServerFnArg<{ text: string }, { id: string; text: string }> = addTodo

// 3. The server half still passes context, and the declaration still receives it typed.
export const withContext = serverFn({ input: t.object({ a: t.string() }) }, async ({ a }, c) => ({
  a,
  method: c.req.method,
}))
