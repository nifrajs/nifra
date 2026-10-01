/** Type-level contract for `notFound()`. Checked by `tsc`, not run. */
import type { Equal, Expect } from "@nifrajs/test-utils"
import type { Platform, Server } from "../src/index.ts"
import { server } from "../src/index.ts"
import { type NotFoundHandler, type NotFoundInput, notFound } from "../src/server/not-found.ts"

type RegistryOf<S> = S extends Server<infer R> ? R : never

interface Env {
  readonly region: string
}

const before = server<Env>().get("/users/:id", (c) => ({ id: c.params.id }))
const after = before.use(
  notFound<Env>((input) => {
    const checks: [
      Expect<Equal<typeof input.platform, Platform<Env> | undefined>>,
      Expect<Equal<typeof input.pathname, string>>,
      Expect<Equal<typeof input.signal, AbortSignal>>,
      Expect<Equal<ReturnType<typeof input.header>, string | null>>,
    ] = [true, true, true, true]
    void checks
    // @ts-expect-error - a request no route matched has no body to read
    input.body
    // @ts-expect-error - and no raw request to read one from
    input.request
    // @ts-expect-error - the view is read-only
    input.pathname = "/other"
    return input.header("accept") === "text/html" ? new Response("<h1>404</h1>") : undefined
  }),
)

// Applying it changes neither the registry nor the context.
export type _Same = Expect<Equal<typeof after, typeof before>>
export type _Registry = Expect<Equal<keyof RegistryOf<typeof after>, "/users/:id">>

// Every accepted shape of handler.
notFound(() => undefined)
notFound(() => {})
notFound(async () => {})
notFound(async () => new Response("x"))
notFound(({ pathname }) => {
  if (pathname.startsWith("/old/")) return Response.redirect("/new", 308)
  return undefined
})

// @ts-expect-error - a value that is not a Response is not an answer
notFound(() => "not found")
// @ts-expect-error - nor is a plain object
notFound(() => ({ ok: false }))
// @ts-expect-error - nor is null
notFound(() => null)
// @ts-expect-error - a handler is required
notFound()

export type _Default = Expect<Equal<Parameters<NotFoundHandler>[0], NotFoundInput<unknown>>>
