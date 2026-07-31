/**
 * The same-origin test every browser-facing endpoint in Nifra uses.
 *
 * One owner, because there are two of these seams - the WebSocket handshake's CSWSH default and the
 * server-function mount - and they answered differently for the same request. A browser that could
 * open a socket was told its POST was cross-origin.
 */

/**
 * True when `origin` is the request's own origin, as observed from inside a possibly-proxied server.
 *
 * The host must match exactly. The scheme must be equal or STRONGER on the Origin side, never weaker:
 *
 *   - `https://app` page → `http://app` request URL: accepted. This is what every TLS-terminating
 *     proxy looks like from the origin server - Cloudflare, a tunnel, an ingress. The socket is plain
 *     HTTP, so `request.url` says `http:` while the browser correctly reports an `https:` page.
 *   - `http://app` page → `https://app` request URL: rejected. Nifra terminated TLS itself here, so a
 *     plaintext page on the same host is the downgrade an attacker would need and buys nothing real.
 *
 * Comparing full origins instead is not the stricter option, it is an outage: measured, it rejects
 * every server-function POST behind a terminating proxy, while the cross-origin attacker it aims at
 * was already rejected by the host comparison. Nifra deliberately does not read `X-Forwarded-Proto` -
 * a forwarded header is attacker-controlled unless something upstream is proven to overwrite it - so
 * the scheme in `request.url` is the socket's, not the browser's, and this asymmetry is how the two
 * are reconciled without trusting a header.
 *
 * An unparseable Origin is not same-origin.
 */
export function isSameOriginRequest(origin: string, request: Request): boolean {
  try {
    const from = new URL(origin)
    const own = new URL(request.url)
    if (from.host !== own.host) return false
    // Written out rather than ranked through a lookup table: a table is a shipped object, and there
    // are exactly two schemes to order. Any other scheme on either side falls through to `false`,
    // which is what refuses `Origin: null`, `file:` and webview schemes.
    if (from.protocol === "https:") return own.protocol === "https:" || own.protocol === "http:"
    if (from.protocol === "http:") return own.protocol === "http:"
    return false
  } catch {
    return false
  }
}
