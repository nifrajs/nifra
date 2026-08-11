---
"@nifrajs/core": minor
---

`assure(app, evidence)` from `@nifrajs/core/assurance` publishes enforcement evidence from outside
the plugin chain. When the thing enforcing a control is not a nifra plugin - an edge gateway, a
service mesh, an outer framework that owns the shell wrapping the app - the assurance policy had no
way to see it, and the only way to keep the app green was switching the affected rules off. The
evidence can now be attached at the mount site or immediately before `serve`, after every route is
registered:

```ts
import { assure, NIFRA_ASSURANCE } from "@nifrajs/core/assurance"

const app = buildApp()
assure(app, { id: NIFRA_ASSURANCE.AUTHENTICATED, source: "edge-gateway" })
serve(app)
```

`scope` defaults to `global`, so the evidence applies to every route already registered; narrow it
with `methods` and `paths` (absolute globs), or pass `scope: "subsequent"` to cover only routes
registered after the call. Invalid evidence ids and `scope: "plugin"` fail closed at the call.

Attached evidence always carries `declared` provenance - nifra did not install the enforcement and
cannot observe it - so a rule with `requireProvenance: "runtime"` still rejects the route. Evidence
declared through `withRouteAssurance` now carries the provenance it was given rather than always
reporting `runtime`.

It lives on the `assurance` subpath and applies through the ordinary middleware seam, so an app that
never calls it carries none of this: the bare server bundle is unchanged.
