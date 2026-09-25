---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/middleware": patch
---

perf(core,node): close the realistic-route Node gap to Fastify

The fused derive-before(-after) lifecycle lanes only had Web (`Response`-building)
renderers, so on the Node-direct lane a derive+before route fell back to the generic
route program while Bun rode the single closure. The same lanes now build a generic
(finalize/wrapResponse-parameterized) fused runner that the Node dispatcher prefers
exactly as it prefers the body-only runner - validate → derive → before → handler →
(after) in one frame, finalizing through the caller's own outcome renderer. Semantics
are stage-for-stage identical to the generic program (pinned by a Web-vs-Node-direct
parity suite); Bun's fused Web lanes are untouched.

`@nifrajs/node`'s JSON writer now emits lowercase `content-type`/`content-length`,
matching the other Node writer paths and the Web runtimes. Proven lowercase,
mutable records stay in place and receive framing headers without the old
rename-and-delete dictionary-mode transition; mixed-case, frozen, and explicitly
framed records keep the isolated normalization fallback.

Realistic-shape bench (oha, auth + security headers + CORS + request-id + cookie,
Node): GET 89% → 96% of Fastify, POST 94% → ~98%, body-hash 92% → 96% (each now at
or above the raw-`node:http` ceiling).
The Node adapter's parser-error drain guard keeps the same close-after-active-responses contract with a per-socket active counter and shared response-finish/close release listener, removing the per-request response Set while retaining close-only abort cleanup.
