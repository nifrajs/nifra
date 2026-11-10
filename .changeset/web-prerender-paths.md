---
"@nifrajs/web": minor
---

`buildTarget` takes `prerenderPaths` for the `static` target: pages to prerender for that build whether or not their route exports `prerender`. `prerenderRoutes` takes the same as `include`, and throws on a path that is no static page route, so a typo cannot ship a site without its page. Any other target refuses `prerenderPaths`.
