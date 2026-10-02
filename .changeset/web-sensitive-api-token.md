---
"@nifrajs/web": patch
---

fix(web): a field named `apiToken` counts as sensitive

`isSensitiveFieldName` matches `apiToken` in any casing or separator (`api_token`, `API-TOKEN`) and
any name ending in it (`githubApiToken`), like `apiKey` and `accessToken`. An output schema that
declares one fails the route when it loads unless the field is wrapped in `t.declassified`,
`nifra check` reports it, and the build's secret scan treats a literal assigned to one as a
credential.
