---
"@nifrajs/graphql": patch
---

The `authorize` option's documentation now gives its real place in a request: after the origin check and before the body is read or parsed, with a CORS preflight skipping it. It said the hook ran after the body parsed.
