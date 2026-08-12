---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/middleware": patch
---

The Node-direct response path asks "are these header names already the lowercase wire spelling"
once per request instead of three times. Core answers it where the answer is already in hand - the
static-header fold derives each name's lowercase form anyway, and the native response walk was
walking the same keys - and publishes it as a symbol-keyed mark the header view and `@nifrajs/node`'s
direct writer read instead of re-scanning. An app that registers a raw `onNodeResponse` twin (one
handed the record itself rather than the case-normalizing view) is never marked and keeps the
per-reader scans, since such a twin writes after the point the mark would be set. Wire output is
unchanged by construction: it is the same answer, from the same pass.

Header-normalization frames fall from 4.1% to 1.5% of self time on a middleware-heavy route and from
1.6% to 0.6% on a hookless one (V8 CPU profile, `GET /users/:id`). `@nifrajs/middleware`'s Node
response twins set one header at a time through a helper that keeps the record in V8's fast property
mode rather than re-homing it into a null-prototype object, which demoted every later lookup on the
response path to dictionary mode.
