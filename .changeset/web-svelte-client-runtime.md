---
"@nifrajs/web": patch
---

fix(web): a Svelte app built with `buildClient` hydrates. `svelteDedupePlugin` pinned the bare
`svelte` import to the entry the build process itself runs - Svelte's server runtime - so the
browser bundle's `hydrate` threw and the server-rendered page never became interactive. For a
browser bundle it now pins the app's one copy and reads that copy's export map with the bundle's own
conditions, which selects the client runtime. A server bundle resolves as before.
