---
"@nifrajs/web": minor
---

feat(web): `@nifrajs/web/vitals` reports Core Web Vitals from real users, each tagged with its route.

```ts
import { reportWebVitals } from "@nifrajs/web/vitals"

reportWebVitals((metric) => {
  const { name, value, rating, id, route } = metric
  const body = JSON.stringify({ name, value, rating, id, route })
  void fetch("/api/vitals", { method: "POST", body, keepalive: true })
})
```

`reportWebVitals` measures LCP, INP, CLS, FCP and TTFB with Google's `web-vitals`, an optional
peer dependency (`bun add web-vitals`), and reports each metric once its value is final, with the
id of the route it belongs to (the id `useMatches` reports). `softNavigations: true` measures each
client-side navigation as a page view of its own where the browser can (Chromium 151 and later),
and `reportAllChanges: true` reports every change instead of the final value. It returns a
function that stops reporting, and does nothing on the server.
