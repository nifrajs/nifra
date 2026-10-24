---
"@nifrajs/web": patch
---

A React server components build no longer prints a `MODULE_LEVEL_DIRECTIVE` warning for every
`"use client"` module in its client and SSR bundles. Only the RSC build acts on the directive, so the
client and SSR builds now drop it before bundling.
