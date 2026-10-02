---
"@nifrajs/web": minor
"@nifrajs/cli": patch
---

feat(web): a directory's route middleware runs before every page in it and below.

```ts
// routes/account/_layout.backend.ts
import { type RouteMiddleware, redirect } from "@nifrajs/web"

export const middleware: RouteMiddleware = ({ request }) => {
  const signedIn = request.headers.get("cookie")?.includes("session=") ?? false
  return signedIn ? undefined : redirect("/login")
}
```

Route middleware runs on the server, outermost first, before the layouts' loaders (gates included)
and the page's loader or action, for document requests, client navigations and form posts alike, and
before a nested `_404` in its directory. It returns nothing to let the request through, or returns or
throws a `redirect()`, a status such as `notFound()`, or a `Response` to answer with it. `ctx.set` adds
headers and cookies, and `ctx.params` holds the params of its directory's URL prefix. It never reaches
the client bundle, and a directory may export it from `_layout.backend.ts` without a frontend layout.
