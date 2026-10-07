---
"@nifrajs/web": patch
---

The Vite dev server crawls the generated client entry for dependencies to pre-bundle, so every route's dependencies are found up front. Opening a route for the first time no longer discovers a new dependency mid-session and reloads the page.
