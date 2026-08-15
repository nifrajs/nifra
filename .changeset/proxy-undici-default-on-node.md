---
"@nifrajs/proxy": minor
---

`createProxy` uses the undici transport by default on Node, and relays a compressed upstream response with its encoding intact.

When no `transport` is given, the proxy now selects the faster undici upstream path on Node whenever `undici` is installed, resolving it lazily so the base package keeps no static dependency on `undici`. Every other runtime (and a Node install without the optional `undici` peer) keeps the portable `fetch` transport. Pass a `transport` explicitly to pin the choice or tune it.

Because undici does not decode `Content-Encoding` the way `fetch` does, a compressed upstream response is now relayed with its `content-encoding` and `content-length` preserved, and the client decodes the bytes it receives - matching how a Node-native reverse proxy passes bytes through, and saving the proxy the decode. A transport that does not decode signals this through the new optional `ProxyUpstreamResponse.bodyEncoded` field; when it is unset (the `fetch` transport, and existing custom transports) the previous strip-and-relay-identity behaviour is unchanged.
