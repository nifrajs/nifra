---
"@nifrajs/core": minor
"@nifrajs/edge": patch
---

`@nifrajs/edge` holds a handler's own reads of `c.request` to `maxBodyBytes` on a route with no body schema, as the full server does for `c.req`. A body past the cap, or a declared Content-Length over it, makes the read throw a `413` response; a malformed Content-Length throws a `400`. Before, such a route read the whole body whatever its size. The cap is built only when the handler first touches `c.request`. `@nifrajs/core/edge-kit` exports the helper, `cappedBodyRequest(request, maxBytes)`.
