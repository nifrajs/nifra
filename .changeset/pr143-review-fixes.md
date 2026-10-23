---
"@nifrajs/web": patch
"@nifrajs/web-react": patch
"@nifrajs/web-preact": patch
"@nifrajs/web-vue": patch
"@nifrajs/cli": patch
---

Keep client-loader reloads safe for cyclic, deeply nested and symbol-bearing data. Limit the initial row-ID index to the sharing sample so replaced lists avoid allocating a full old-row map, and benchmark lightweight rotating-ID payloads.

Preserve layout-injected child props in React and Preact and page caching and leave transitions in Vue while retaining unchanged-data render skipping.

Vue keeps patching an unchanged layout chain in place after a layout re-renders on its own between router renders.

Recognize Svelte's unshadowed `$state.raw()` rune without weakening SQL checks for shadowed or imported database bindings.
