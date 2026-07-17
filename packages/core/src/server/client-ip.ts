/**
 * Deriving the caller's IP (`c.clientIp`), correctly and vendor-neutrally.
 *
 * The default is the raw socket peer the serving adapter observed - the only value that cannot be
 * forged by a client, since the client never controls who the TCP connection comes from. Behind a
 * reverse proxy or CDN the socket peer is the proxy, not the caller, so a `Forwarded`/`X-Forwarded-For`
 * value must be consulted - but ONLY as far as you actually trust the hops in front of you, because a
 * directly-reachable app lets any client forge those headers. The trust is therefore an explicit,
 * opt-in declaration; with none set, `c.clientIp` is the socket peer and no header is ever believed.
 *
 * No vendor names live here: a Cloudflare/Fastly/nginx deployment declares its own header or hop count.
 */

/**
 * How much of the forwarding chain to trust when deriving `c.clientIp`. Omit for the safe default
 * (socket peer only, no header believed).
 *
 * - `{ trustedHops: n }` - trust `n` reverse-proxy hops in front of the app. The caller is taken from
 *   `X-Forwarded-For` counted from the right past the `n` trusted hops (the socket peer is hop 0). Use
 *   this when the app sits behind `n` proxies **you operate**. Fewer entries than trusted hops means
 *   the header is too short to trust, so `c.clientIp` is `undefined` (fail closed).
 * - `{ header: name }` - trust a single named header's first value (e.g. a CDN that overwrites it at
 *   the edge). Only declare this when the app is reachable **exclusively** through that edge; a
 *   directly-reachable app lets any client forge the header.
 */
export type ClientIpTrust = { readonly trustedHops: number } | { readonly header: string }

function firstHeaderValue(req: Request, header: string): string | undefined {
  const raw = req.headers.get(header)
  if (raw === null) return undefined
  const first = raw.split(",", 1)[0]?.trim()
  return first === undefined || first === "" ? undefined : first
}

/**
 * Resolve the caller IP from the raw socket `peer` (adapter-observed), the request's forwarding
 * headers, and the app's `trust` declaration. Pure and synchronous.
 */
export function resolveClientIp(
  peer: string | undefined,
  req: Request,
  trust: ClientIpTrust | undefined,
): string | undefined {
  if (trust === undefined) return peer
  if ("header" in trust) return firstHeaderValue(req, trust.header)

  // trustedHops: walk `X-Forwarded-For` (client-most first) plus the socket peer as the closest hop.
  const xff = req.headers.get("x-forwarded-for")
  const forwarded =
    xff === null
      ? []
      : xff
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "")
  const chain = peer !== undefined ? [...forwarded, peer] : forwarded
  // The caller sits just left of the `trustedHops` trusted proxies at the tail of the chain.
  const index = chain.length - 1 - trust.trustedHops
  return index >= 0 ? chain[index] : undefined
}
