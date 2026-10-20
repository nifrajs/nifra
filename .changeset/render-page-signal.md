---
"@nifrajs/web": minor
---

`renderPage` takes the request's `signal`. A deferred value that rejects because that signal aborted is the client leaving, so the server log skips it; a real failure is still logged. `createWebApp` passes each request's signal, so a full page load whose client leaves mid-stream no longer logs `[nifra/web] deferred value rejected`.
