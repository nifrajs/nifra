---
"@nifrajs/core": minor
"@nifrajs/web": minor
---

Support path segments that are part literal, part parameter.

A route segment had to be wholly static, wholly a parameter, or wholly a wildcard. `/:key.txt`,
`/post-[id].html` and `/[locale]-sitemap.xml` did not merely fail to match - they failed to
**compile**. The trigger was an IndexNow key-verification file, which the protocol requires at
`<origin>/<key>.txt` with the key coming from deploy-time config, and at the root, because a key
served from a subdirectory only authorises URLs beneath it. The workaround was an exact-match check in
the app's server entry, which moved a routing concern out of the router and never ran in dev.

Both spellings now work: `:key.txt` in a route pattern, and `[inKey].txt.tsx` as a file route. The
parameter name is the longest identifier run after `:`; everything else in the segment is literal.
Precedence is static > mixed > param > wildcard, decided by shape rather than registration order, so
`/robots.txt` still beats `/:key.txt` and `/jobs/:id.txt` beats `/jobs/:id`.

Inside a mixed segment, `[[optional]]` and `[...catchAll]` are **rejected** at build time rather than
given a meaning: there is no sensible absent form for `/[[locale]]-feed.xml`, and a catch-all captures
the rest of the path, which a trailing literal can never follow.

**Literal colons keep their meaning.** A `:` that follows an identifier character and runs to the end
of its segment is literal, so the established RPC-style action shape - `/v1/things:batchGet` - still
routes as written rather than capturing `batchGet` into a parameter named after the verb. Mixed
parameters remain available everywhere they are unambiguous: at the start of a segment (`/:key.txt`),
after punctuation (`/post-:id`), or with a literal suffix (`/v:major.json`). A `:` not followed by a
valid identifier start (`/ratio:2`) is literal as before.

Mixed siblings are ordered by ONE total comparator shared between the server's trie router and the
browser's matcher. Ordering by literal weight alone left ties broken differently on each side, so
`/bar.:value` and `/:value.foo` could resolve to different routes for the same URL - visible only as a
soft navigation rendering the wrong page.

Adding a mixed pattern can also make a previously unambiguous path ambiguous: with both `/jobs/:id` and
`/jobs/:id.txt` registered, `/jobs/a.txt` now matches the mixed route with `id="a"` where before it
could only match the bare param with `id="a.txt"`. Deterministic, and only for apps that opt in by
registering a mixed pattern.

An app that registers no mixed segment allocates nothing for this and pays one `undefined` check on
the match path. The rejected-parameter hint added in the previous release is removed - `:id.json` was
the shape it explained, and `:id.json` now compiles.
