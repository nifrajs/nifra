---
"@nifrajs/core": patch
---

On a route with a body schema that runs auth before validation, direct `c.req` body reads made by its derive and `beforeHandle` hooks are capped by the route's `bodyLimit`, as they are on a route without a body schema.
