---
"@nifrajs/core": patch
---

fix(core): `c.params` is typed by the names the router captures for a segment that mixes literal
text and parameters. `/files/:name.json` types `c.params.name`, `/v:major.:minor` types `major` and
`minor`, and `/b/:bucket.s3/*key` types `bucket` and `key`; each was previously typed as one
parameter named after the rest of the segment (`"name.json"`), so reading the real name did not
compile. A colon that is literal text, as in `/v1/things:batchGet`, no longer types a parameter.
Paths whose parameters are whole segments are typed as before.
