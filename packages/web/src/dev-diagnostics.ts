/**
 * The dev server's diagnostics surface, shared by both dev-server adapters - Bun in `dev.ts`, Vite in
 * `vite.ts`. It owns the one contract that must never drift between them: capture the most recent SSR
 * failure, serve it as JSON at `LAST_ERROR_PATH` with the identity + no-store headers an agent relies on,
 * and render that same failure as the developer overlay. Each adapter keeps only its bundler-specific
 * transport (Bun.serve + HMR vs Vite middlewares + `ssrFixStacktrace`); the diagnostic behaviour lives
 * here once, so a new header or a new capture rule is a single edit both servers pick up.
 *
 * Vite once shipped without the `/__nifra/last-error` endpoint at all - the drift this module prevents.
 */
import { renderDiagnosticOverlay } from "./dev-error.ts"
import { buildDiagnostic, type Diagnostic, LAST_ERROR_PATH } from "./diagnostic.ts"

export interface DevDiagnostics {
  /** True when a request path targets the structured last-error endpoint. */
  isLastErrorPath(pathname: string): boolean
  /** The JSON body + headers for the last-error endpoint: the most recent failure, or a benign
   * `NIFRA_NONE` shape when nothing has failed yet. `no-store` so a stale failure is never cached. */
  lastError(): { readonly body: string; readonly headers: Readonly<Record<string, string>> }
  /** Capture a thrown SSR failure: store it for the endpoint and return the overlay HTML. The overlay a
   * person sees and the JSON an agent reads come from this one Diagnostic, so they can never disagree. */
  capture(err: unknown, request: { readonly method: string; readonly url: string }): string
}

/** One diagnostics surface per dev server. `root` is the resolved project root; it scopes the codeframe
 * to the project (see buildDiagnostic). Both dev servers resolve a concrete root before calling this. */
export function createDevDiagnostics(root: string): DevDiagnostics {
  let last: Diagnostic | undefined
  return {
    isLastErrorPath: (pathname) => pathname === LAST_ERROR_PATH,
    lastError: () => ({
      body: JSON.stringify(
        last ?? { code: "NIFRA_NONE", message: "No error captured since the dev server started." },
      ),
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-nifra-diagnostic": "true",
      },
    }),
    capture: (err, request) => {
      last = buildDiagnostic(err, { root, request })
      return renderDiagnosticOverlay(last)
    },
  }
}
