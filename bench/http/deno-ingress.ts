/**
 * Shared Deno benchmark ingress. Every framework receives the same Deno.serve callback shape and
 * the same platform framing marker; only the framework fetch handler changes.
 *
 * The marker is a registered symbol because the benchmark's Nifra app is loaded from a built
 * artifact while the adapter intentionally has no runtime dependency on core. It models the
 * transport guarantee that Deno's HTTP parser has already delimited the request body.
 */
const TRUSTED_FRAMING = Symbol.for("nifra.body.trustedFraming")

// This helper is also imported by the Bun-driven benchmark typecheck, which intentionally does not
// load Deno's ambient library. Keep the tiny runtime surface local instead of making the workspace
// TypeScript project depend on a second host's globals.
declare const Deno: {
  serve(
    options: { readonly port: number; readonly onListen: () => void },
    handler: (request: Request) => Response | Promise<Response>,
  ): unknown
}

export function serveFetch(
  fetch: (request: Request) => Response | Promise<Response>,
  port: number,
): void {
  Deno.serve({ port, onListen() {} }, (request) => {
    ;(request as unknown as Record<symbol, unknown>)[TRUSTED_FRAMING] = true
    return fetch(request)
  })
}
