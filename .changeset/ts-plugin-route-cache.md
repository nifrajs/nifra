---
"@nifrajs/ts-plugin": patch
---

Go-to-definition on a route path compiles and sorts the app's route patterns once per route set instead of on every request. The cache was keyed by the route array, and route discovery returns a new array each time, so it never hit and every cursor move recompiled every route. A route set that changes (a route added, renamed or removed) still compiles afresh.
