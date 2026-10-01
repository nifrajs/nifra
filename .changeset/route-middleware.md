---
"@nifrajs/web": minor
"@nifrajs/cli": patch
---

feat(web): a `_middleware.ts` runs before every page in its directory and below.

```ts
// routes/account/_middleware.ts
import { type RouteMiddleware, redirect } from "@nifrajs/web"

const middleware: RouteMiddleware = ({ request }) => {
  const signedIn = request.headers.get("cookie")?.includes("session=") ?? false
  return signedIn ? undefined : redirect("/login")
}

export default middleware
```

Route middleware runs on the server, outermost first, before the layouts' loaders (gates included)
and the page's loader or action, for document requests, client navigations and form posts alike, and
before a nested `_404` in its directory. It returns nothing to let the request through, or returns or
throws a `redirect()`, a status such as `notFound()`, or a `Response` to answer with it. `ctx.set` adds
headers and cookies, and `ctx.params` holds the params of its directory's URL prefix. It never reaches
the client bundle. A `_middleware.tsx` is refused at startup rather than silently ignored, and
`nifra check` counts `_middleware.ts` when it compares a committed server manifest with `routes/`.
