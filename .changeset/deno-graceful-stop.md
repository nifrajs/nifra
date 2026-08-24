---
"@nifrajs/deno": patch
---

Make Deno server shutdown drain active handlers safely across Deno runtime releases and force-close requests that exceed the configured deadline without triggering a `BadResource` race.
