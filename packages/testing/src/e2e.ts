/**
 * Browser-test glue: an ephemeral server plus typed URLs plus the session handoff - everything
 * nifra-specific about driving a real browser, and nothing else. This is deliberately NOT a test
 * runner (bring Playwright or Vitest Browser for the browser itself): API flows already run faster
 * in-process through {@link testSession}, so this module covers only what in-process cannot - a
 * real socket, real navigation, real rendering.
 *
 * ```ts
 * import { chromium } from "@playwright/test"
 * import { e2eUrl, serveTestApp } from "@nifrajs/testing/e2e"
 * import { testSession } from "@nifrajs/testing"
 * import { app } from "../src/app"
 *
 * const { cookies } = testSession<typeof app>(app)
 * await api.auth.login.post(credentials) // in-process login; jar captures the session
 *
 * const www = await serveTestApp(app)
 * const browser = await chromium.launch()
 * const page = await browser.newPage({
 *   extraHTTPHeaders: { Cookie: cookies.header() }, // the session crosses into the browser
 * })
 * await page.goto(e2eUrl<typeof app>(www.baseUrl, "/dashboard")) // typo'd path won't compile
 * await www.stop()
 * ```
 */
import type { Server } from "@nifrajs/core/server"
import { isSameOriginPath } from "@nifrajs/core/server"
import type { NodeServer, ServeOptions } from "@nifrajs/node"

/** The minimal shape a nifra `server()` app satisfies - its own `fetch`. */
export interface E2EApp {
  fetch(request: Request): Response | Promise<Response>
}

/** Every route path the app declares - constrains `e2eUrl`, so a wrong path is a type error. */
export type E2EPaths<App> = App extends Server<infer R, infer _Ctx> ? keyof R & string : never

export interface ServeTestAppOptions {
  /** Port to bind. Default `0` (ephemeral - read the real one off {@link ServedTestApp.baseUrl}). */
  readonly port?: number
  /** Interface to bind. Default `"127.0.0.1"`. */
  readonly hostname?: string
}

export interface ServedTestApp {
  /** Origin serving the app, e.g. `"http://127.0.0.1:43127"`. Hand it to {@link e2eUrl}. */
  readonly baseUrl: string
  /** Stop accepting connections and drain in-flight requests. Idempotent. */
  readonly stop: () => Promise<void>
}

/**
 * Serve an app on an ephemeral port for one browser test. The server is `@nifrajs/node`
 * (an optional peer - install it in devDependencies); when it is absent this throws a plain
 * error naming the missing package instead of a module-resolution crash.
 */
export async function serveTestApp(
  app: E2EApp,
  options: ServeTestAppOptions = {},
): Promise<ServedTestApp> {
  let serve: (app: E2EApp, options: ServeOptions) => Promise<NodeServer>
  try {
    ;({ serve } = await import("@nifrajs/node"))
  } catch {
    throw new Error(
      "@nifrajs/testing/e2e: serveTestApp needs the @nifrajs/node package - add it to devDependencies",
    )
  }
  const hostname = options.hostname ?? "127.0.0.1"
  const running = await serve(app, { port: options.port ?? 0, hostname })
  return {
    baseUrl: `http://${hostname}:${running.port}`,
    stop: () => running.stop(),
  }
}

/**
 * Join `baseUrl` and a declared route path. The path is checked against the app's registry, so
 * `page.goto(e2eUrl<typeof app>(www.baseUrl, "/dashbord"))` fails typecheck instead of 404ing
 * mid-suite - the same guarantee `formFor` gives form fields.
 */
export function e2eUrl<App>(baseUrl: string, path: E2EPaths<App>): string {
  if (!isSameOriginPath(path)) {
    throw new TypeError("@nifrajs/testing/e2e: path must be a same-origin absolute path")
  }
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
  const resolved = new URL(path, base)
  if (resolved.origin !== base.origin) {
    throw new TypeError("@nifrajs/testing/e2e: path escaped the test app origin")
  }
  return resolved.href
}
