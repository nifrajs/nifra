---
"@nifrajs/core": minor
"@nifrajs/web": minor
"@nifrajs/client": minor
"@nifrajs/testing": minor
---

A path segment has one spelling in every place a framework writes one. `@nifrajs/core/pattern` exports `encodePathSegment(value)`, `decodePathSegment(raw)`, `browserPathSegment(value)` and `fillRoutePath(pattern, params)`. `encodePathSegment` leaves `A-Za-z0-9 - . _ ~ ! $ & ' ( ) * + , : = @` as written and percent-encodes everything else in upper-case hex, so `;`, `[`, `]` and `|` are escaped (a proxy that reads `;` as a path parameter cannot change the path). A value no segment can carry (`.`, `..`, a lone surrogate) throws `RangeError`. `fillRoutePath` reports a value the router would read back as different params, such as `name` = `a.b` in `:name.:ext`, as invalid.

`getStaticPaths` output, the prerender report and written files, `enumerateStaticRoutes`, the typed client's path params and the contract fuzzer's request paths all use it. A `getStaticPaths` entry that leaves out a param or holds one no path can carry is skipped, and the prerender report names the param. Files in `public/` are served under the spelling a page links and the one a browser sends for the same name.
