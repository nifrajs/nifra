---
"@nifrajs/web": patch
---

A page warmed by `prefetch` (a hovered or visible link) is no longer served after something changed it. Every page action and fetcher action drops all warmed pages, as does `identityChanged()`, a sign-in or sign-out another tab announces, and a changed identity epoch cookie; a revalidated path's warmed copy is dropped too. A prefetch still loading when an action lands is not kept. Before, a navigation within 30 seconds of a sign-out and sign-in could show the page loaded for the previous visitor.
