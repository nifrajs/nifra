import { readBoundedBytes, TransportCodecError } from "@nifrajs/core/transport-codec"
import type { CacheStore } from "../../isr.ts"
import type { ShellCheckRecord } from "./compile-shell.ts"
import {
  PPR_CANCEL_PATH,
  type PprEnvironment,
  type PprIntegration,
  PprShellCold,
  PprShellUnavailable,
  PprShellUnchecked,
  variationQuery,
  wantsBlockingRender,
} from "./contract.ts"
import type { ResolvedPprOptions } from "./options.ts"
import { assertPprRoute, variationsOf } from "./route-rules.ts"
import { createPprServer } from "./server.ts"
import { digest, sharedShellStore } from "./shell-store.ts"

// The stream sets its own type, caching and CSP; a middleware or gate header joins the rest.
const OWN_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "cache-control",
  "content-security-policy",
  "content-length",
])

const MAX_CANCEL_BYTES = 64

/** Where shells are shared beyond the process, as `partialPrerendering` checked them. */
export interface PprSharing {
  readonly store: CacheStore | undefined
  readonly storeSecret: string | undefined
  readonly deployment: string | undefined
}

/**
 * The deployment every shell key names. The client entry changes with each client build; each route's
 * checked shell hash changes with its shell code, which the client entry does not see; the
 * platform's own name, when given, covers the rest.
 */
export function shellDeployment(
  clientEntry: string,
  shellChecks: ShellCheckRecord | "unchecked-development",
  named: string | undefined,
): string {
  if (shellChecks === "unchecked-development" && named === undefined) return clientEntry
  const routes =
    shellChecks === "unchecked-development"
      ? ""
      : Object.keys(shellChecks.routes)
          .sort()
          .map((id) => `${id}=${shellChecks.routes[id]}`)
          .join(",")
  return `${clientEntry}~${digest(`${routes}|${named ?? ""}`)}`
}

/** One app's partial prerendering, made when `createWebApp` reaches its `ppr`. */
export function createPprIntegration(
  options: ResolvedPprOptions,
  shellChecks: ShellCheckRecord | "unchecked-development",
  origin: string | undefined,
  environment: PprEnvironment,
  sharing: PprSharing = { store: undefined, storeSecret: undefined, deployment: undefined },
): PprIntegration {
  const { perRequestNonce, ...app } = environment
  if (perRequestNonce) {
    throw new TypeError(
      "[nifra/web] ppr cannot use `nonce`: a per-request nonce would make every shell unique. Use `csp: createCspPolicy(...)`, or no policy",
    )
  }
  const deployment = shellDeployment(app.deployment, shellChecks, sharing.deployment)
  const server = createPprServer({
    ...app,
    deployment,
    clientEntry: app.deployment,
    options,
    cancelUrl: PPR_CANCEL_PATH,
    shellChecks,
    shared:
      sharing.store === undefined || sharing.storeSecret === undefined
        ? undefined
        : sharedShellStore(sharing.store, sharing.storeSecret, deployment),
  })
  const uncheckedWarned = new Set<string>()
  return {
    server,
    // biome-ignore lint/plugin/noConditionalEmptyObjectSpread: an app with no configured origin has none, which shell meta reads as absent.
    ...(origin === undefined ? {} : { origin }),
    cancelPath: PPR_CANCEL_PATH,
    // A beacon carries one 22-character token; anything longer is not one. The token is unguessable,
    // so the answer is the same whether it named a live response or not.
    async cancel(request) {
      const length = Number(request.headers.get("content-length") ?? "NaN")
      if (!(length > 0 && length <= MAX_CANCEL_BYTES)) return new Response(null, { status: 400 })
      let token: Uint8Array
      try {
        // The header is a claim; the cap holds on the bytes that arrive.
        token = await readBoundedBytes(new Response(request.body, { headers: request.headers }), {
          maxBytes: MAX_CANCEL_BYTES,
        })
      } catch (error) {
        if (error instanceof TransportCodecError) return new Response(null, { status: 400 })
        throw error
      }
      server.cancel(new TextDecoder().decode(token))
      return new Response(null, { status: 204 })
    },
    async stream(request, written) {
      if (wantsBlockingRender(options, request.request)) return "settled"
      let response: Response
      try {
        response = await server.respond(request)
      } catch (error) {
        if (!(error instanceof PprShellUnavailable)) throw error
        if (error instanceof PprShellCold) return "deferred"
        if (error instanceof PprShellUnchecked && !uncheckedWarned.has(request.routeId)) {
          uncheckedWarned.add(request.routeId)
          console.warn(error.message)
        }
        return "settled"
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
