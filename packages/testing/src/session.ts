/**
 * A stateful, cookie-aware in-process test client. `@nifrajs/client`'s `testClient` already drives an
 * app's `fetch` with end-to-end types (no server/port/network) — this wraps it with a {@link CookieJar}
 * that carries `Set-Cookie` across calls, so a login → authenticated-request flow just works.
 *
 *   import { testSession } from "@nifrajs/testing"
 *   import { app } from "../src/app"
 *
 *   const { client, cookies } = testSession<typeof app>(app)
 *   await client.auth.login.post({ email, password })   // Set-Cookie captured
 *   const me = await client.me.get()                     // Cookie sent automatically
 *   expect(me.ok && me.data.id).toBeDefined()
 */
import { type ClientOptions, client, type FetchFn, type Treaty } from "@nifrajs/client"
import { type CookieJar, cookieJar } from "./cookies.ts"

/** The minimal shape a nifra `server()` app satisfies — its own `fetch`. */
export interface AppLike {
  fetch(request: Request): Response | Promise<Response>
}

export interface TestSessionOptions extends Omit<ClientOptions, "fetch"> {
  /** Origin used to resolve relative paths. Default `"http://nifra.internal"`. */
  readonly origin?: string
  /** Reuse an existing jar (e.g. seed a session cookie, or share one across sessions). */
  readonly cookies?: CookieJar
}

export interface TestSession<App> {
  /** The end-to-end-typed in-process client — every call carries + captures cookies. */
  readonly client: Treaty<App>
  /** The jar backing this session — inspect (`cookies.get("sid")`), seed, or `clear()` it. */
  readonly cookies: CookieJar
}

/** Create a cookie-persisting in-process test client for `app`. */
export function testSession<App extends AppLike>(
  app: App,
  options: TestSessionOptions = {},
): TestSession<App> {
  const { origin = "http://nifra.internal", cookies = cookieJar(), ...clientOptions } = options
  const bridge: FetchFn = async (url, init) => {
    const headers = new Headers(init?.headers)
    cookies.applyTo(headers)
    const response = await app.fetch(new Request(url, { ...init, headers }))
    cookies.store(response)
    return response
  }
  return { client: client<App>(origin, { ...clientOptions, fetch: bridge }), cookies }
}
