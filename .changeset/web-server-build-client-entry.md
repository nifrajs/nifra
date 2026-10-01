---
"@nifrajs/web": patch
---

fix(web): the server build fails when `clientEntry` is missing.
`buildServer`, `buildServerVite`, and `generateServerManifest` throw a `TypeError` when `clientEntry`
is not a string - for example an option spelled `client` - instead of baking `clientEntry = undefined`
into the server manifest and leaving every hydrating page to fail at request time. An empty string
is still accepted for an app with no client script.
