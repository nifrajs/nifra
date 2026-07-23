---
"@nifrajs/web": minor
"@nifrajs/core": patch
---

Let a route loader answer 404 and 410.

A matched route whose loader finds nothing had no supported way to set its page's status, so the path
of least resistance was to return empty data and render "not found" inside a **200**. That is a soft
404: search engines penalise it and keep the dead URL indexed, and because the page looks correct in a
browser it ships and stays shipped. It is the most common page shape there is - a detail route whose
record may not exist.

`notFound()`, `gone()`, and `statusPage(status)` are thrown from a loader, the way `redirect()` already
is. They render the `_404` page - or `_410.tsx` / `_<status>.tsx` if the app authored one - inside the
normal layout chain, hydrated, at the right status. A `headers` option carries the cache policy each
status wants: a 404 may be racing publication and wants a short TTL, while a 410 is a promise that the
URL is permanently gone. Typed `never`, so a loader narrows without a redundant `return`.

410 is not a pedantic 404: it tells a crawler to drop the URL instead of re-fetching it for weeks.

Existing behaviour is unchanged by construction. The signal is a branded `Response` and the brand is
checked before the verbatim pass-through, so `throw redirect(...)`, `throw new Response(...)`, and a
real `Error` reaching `_error` all behave exactly as before. Client-side navigation and prerendering
already handle a non-ok render correctly and now have tests pinning that: a soft-nav falls back to a
full navigation and lands on the same page, and a prerendered path whose loader signals is omitted
from the build rather than baked as a static 200 shell.

`renderPageResult` gains a `headers` option. `content-type` and the ISR freshness header stay
framework-owned and cannot be overridden through it.

Also trims the router's rejected-parameter message added in the previous release. The explanation cost
~0.3 KB gzip in every bundle; it now states the grammar rule and the two ways out without building an
example path, which is a third smaller and keeps the base bundle inside its budget.
