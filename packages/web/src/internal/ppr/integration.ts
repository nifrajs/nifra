import type { ShellCheckRecord } from "./compile-shell.ts"
import {
  PPR_CANCEL_PATH,
  type PprEnvironment,
  type PprIntegration,
  PprShellUnavailable,
  PprShellUnchecked,
  variationQuery,
  wantsBlockingRender,
} from "./contract.ts"
import type { ResolvedPprOptions } from "./options.ts"
import { assertPprRoute, variationsOf } from "./route-rules.ts"
import { createPprServer } from "./server.ts"

// The stream sets its own type, caching and CSP; a middleware or gate header joins the rest.
const OWN_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "cache-control",
  "content-security-policy",
  "content-length",
])

/** One app's partial prerendering, made when `createWebApp` reaches its `experimental.ppr`. */
export function createPprIntegration(
  options: ResolvedPprOptions,
  shellChecks: ShellCheckRecord | "unchecked-development",
  origin: string | undefined,
  environment: PprEnvironment,
): PprIntegration {
  const { perRequestNonce, ...app } = environment
  if (perRequestNonce) {
    throw new TypeError(
      "[nifra/web] experimental.ppr needs `csp: createCspPolicy(...)`, not `nonce`: a per-request nonce would make every shell unique",
    )
  }
  const server = createPprServer({ ...app, options, cancelUrl: PPR_CANCEL_PATH, shellChecks })
  const uncheckedWarned = new Set<string>()
  return {
    server,
    ...(origin === undefined ? {} : { origin }),
    cancelPath: PPR_CANCEL_PATH,
    // A beacon carries one 22-character token; anything longer is not one. The token is unguessable,
    // so the answer is the same whether it named a live response or not.
    async cancel(request) {
      const length = Number(request.headers.get("content-length") ?? "NaN")
      if (!(length > 0 && length <= 64)) return new Response(null, { status: 400 })
      server.cancel(await request.text())
      return new Response(null, { status: 204 })
    },
    async stream(request, written) {
      if (wantsBlockingRender(options, request.request)) return undefined
      let response: Response
      try {
        response = await server.respond(request)
      } catch (error) {
        if (!(error instanceof PprShellUnavailable)) throw error
        if (error instanceof PprShellUnchecked && !uncheckedWarned.has(request.routeId)) {
          uncheckedWarned.add(request.routeId)
          console.warn(error.message)
        }
        return undefined
      }
      for (const [name, value] of Object.entries(written() ?? {}))
        if (!OWN_HEADERS.has(name)) response.headers.set(name, value)
      return response
    },
    shellData: (request, signal) =>
      server
        .shellData(request)
        .catch((error: unknown) =>
          error instanceof PprShellUnavailable ? request.loadShell(signal) : Promise.reject(error),
        ),
    variationQuery,
    assertRoute: (route, layouts, boundaries) =>
      assertPprRoute(route, layouts, boundaries, options),
    variationsOf,
  }
}
