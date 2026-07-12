---
"@nifrajs/web": patch
---

fix(web): the static/client build no longer ships the generated `_nifra-entry.ts` source. `buildClient`
wrote the client-entry source into the output dir purely as a `Bun.build` entrypoint but never removed it
after bundling — so `nifra build --target static` leaked the TypeScript source next to the content-hashed
`_nifra-entry-<hash>.js` the HTML actually references. It's now deleted once the client bundle succeeds; a
static-build test asserts the `.ts` is absent from the output.
