---
"@nifrajs/web": minor
"@nifrajs/client": minor
---

feat(web): a loader or action sets response headers and cookies through `ctx.set`. It has `headers`,
`cookie()`, and `deleteCookie()`, the page counterpart of a route handler's `c.set`.
`LoaderResponseControls` is exported from `@nifrajs/web` and `@nifrajs/client`.

- `ctx.set.headers` applies to the rendered document. It is not applied to a redirect, a status page,
  an error page, or a navigation data response.
- Each loader has its own header record. They merge layouts root to leaf, then the page loader, then
  the action, so the most specific writer wins a name whichever loader settles first.
- `content-type`, `set-cookie`, `location`, the transport headers, and the `x-nifra-` prefix are
  refused. So is a name that is not an HTTP token, and a value with a line break, a control
  character, or a character outside Latin-1. The error names the header, never its value.
- `ctx.set.cookie()` uses the same secure defaults as `c.set.cookie` and rides every outcome,
  including a thrown `Response`. A queued cookie makes the response `cache-control: private, no-store`
  - the document, a redirect, a status or error page, a hand-built `Response` - and keeps the page out
  of `withISR`.
- The controls close when the loader or action settles. A later write throws.
- `enableDraft(ctx, secret)` works from a loader or action.

Behavior changes:

- A navigation data response, from a loader or an action, is now always
  `cache-control: private, no-store` with `vary: x-nifra-data`. It shares its URL with the document,
  so a cache keyed on the URL must not store it.
- A document that carries loader headers has `x-nifra-data` added to its `vary`.
- `withISR` stores a page whose only `vary` token is `x-nifra-data`, and replays `x-robots-tag`.
- `LoaderContext` and `LoaderArgs` have a required `set`. A test that builds one by hand needs to
  supply it.
