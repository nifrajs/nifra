---
"@nifrajs/web": patch
---

`/llms.txt` and `/llms-full.txt` list backend routes only when the backend is served over HTTP at `apiPrefix`; a backend the loaders call in-process (`apiPrefix: ""`) is not described. An app route at either path takes precedence instead of failing to boot, each text is built once per app, and the new `llmsTxt: false` option registers neither path.
