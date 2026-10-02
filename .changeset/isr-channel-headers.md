---
"@nifrajs/web": patch
---

fix(web): a route's ISR freshness and tags stay between the app and its cache wrapper

`x-nifra-isr-revalidate` and `x-nifra-isr-tags` carry a route's `revalidate` and `revalidateTags`
to `withISR`. An app with no wrapper sent both to every visitor, and `withISR` passed them through
on responses it did not store (a query string under the default policy, a keyless request, a page
it refused to cache). `createWebApp` now emits them only once a wrapper attaches, and `withISR`
removes them from every response it returns.
