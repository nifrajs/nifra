---
"@nifrajs/core": patch
---

fix(core): a path segment that mixes literal text and parameters - `/:name.json`, `/v:major.:minor`,
`/:a-:b-:c.json` - is matched in one pass over the segment. The time a lookup takes grows with the
length of the segment and no longer with the number of parameters in it, for a hit and for a miss
alike. This holds for the server's router, `Router.find` from `@nifrajs/core/router`, and
`matchRoutePattern` from `@nifrajs/core/pattern`.

Which paths match and what each parameter captures are unchanged: a literal between two parameters
is taken at its first occurrence, a trailing literal ends the segment, and every parameter is at
least one character.

`@nifrajs/core/pattern` also exports the matcher itself: `mixedSegmentShape(parts)` lays a mixed
segment out once, and `matchMixedSegment(shape, segment, out)` appends the captures to `out` and
answers whether the segment matched.
