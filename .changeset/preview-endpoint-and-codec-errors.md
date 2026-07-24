---
"@nifrajs/web": minor
"@nifrajs/core": patch
---

Add `previewEndpoint` for draft/preview mode, and make transport codec decode errors uniform.

`previewEndpoint({ secret, draftSecret })` is a `fetch` handler for the link your CMS's "Preview"
button points at: it checks the preview token in constant time, turns draft mode on with the signed
`__nifra_draft` cookie, and redirects the editor to the requested page. It is the link-borne sibling
of `revalidateEndpoint`, and it exists because gating the route by hand means writing two checks that
are easy to get subtly wrong and that fail silently when you do - the token compare must not exit
early on the first wrong character, and the `?to=` destination must not be allowed off-site
(`//evil.com` and `/\evil.com` both start with a slash yet navigate away). Wrong or missing token
gives `401`, an off-site destination `400`, and success a `302` carrying `Cache-Control: no-store`
so no shared cache can replay one editor's draft session to a visitor. Param names, the fallback
destination, and cookie lifetime/path/`Secure` are all configurable.

`decodeTransportFrame` and `decodeTransportResponse` now raise `TransportCodecError` for a malformed
payload instead of letting the underlying `SyntaxError` through, with the original kept as `cause`.
Every other failure in that module was already a `TransportCodecError`, so a malformed payload - the
likeliest hostile input - was the one case that slipped past callers catching the documented error
type. `TransportCodecError` accepts an `ErrorOptions` second argument to carry that cause. Bytes that
are not valid UTF-8 take the same path: the `TypeError` from the strict decoder used to escape ahead
of any codec, so the one input that never reached a codec at all was also the one that reported
differently from every other decode failure.
