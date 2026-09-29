---
"@nifrajs/web": patch
"create-nifra": patch
---

fix(web): portable public-directory serving and required endpoint secrets

`publicDir()` now serves files on Node and Deno as well as Bun, sets `content-type` from the file
extension, sends `x-content-type-options: nosniff`, and never serves dot-prefixed paths other than
`/.well-known/`.

`revalidateEndpoint()` and `previewEndpoint()` throw at construction when `secret` is empty or
missing. The ISR starter answers 404 on its revalidate route until `REVALIDATE_SECRET` is set.
