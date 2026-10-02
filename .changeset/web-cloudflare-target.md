---
"@nifrajs/web": major
---

feat(web)!: the Cloudflare Pages build target is `cloudflare`

`BUILD_TARGETS` and `buildTarget` / `buildTargetVite` name it `"cloudflare"` (it emits the same
`_worker.js` + `_routes.json` deploy directory). `"cf-pages"` is refused with the new name.
`parseBuildTarget(value)` returns a string as a `BuildTarget`, or throws with the same message.
