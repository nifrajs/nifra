---
"@nifrajs/core": patch
---

Every JSON body core renders on Deno and Workers carries `application/json`, the Content-Type those
runtimes' own `Response.json` writes. Some of the framework's own answers (404, 422) carried Bun's
`application/json;charset=utf-8` there, so one app answered in two spellings. Bun is unchanged.
