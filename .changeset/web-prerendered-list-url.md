---
"@nifrajs/web": patch
---

A large `prerenderedPaths` set no longer rides in every page. Over 4 KB of JSON, `createWebApp` serves the set once from `/__nifra/prerendered.json?v=<version>` (cached for good at that versioned URL) and pages hand over only the URL; the client router fetches it once, on load, and uses it as before. `prerenderRoutes` writes the file into a static output whenever its pages reference it. Smaller sets are still inlined, unchanged.
