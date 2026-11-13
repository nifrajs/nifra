---
"@nifrajs/agent": patch
"@nifrajs/agent-app": patch
"@nifrajs/agent-protocol": patch
"@nifrajs/better-auth": patch
"@nifrajs/cli": patch
"@nifrajs/coding-agent": patch
"@nifrajs/deno": patch
"@nifrajs/i18n": patch
"@nifrajs/image": patch
"@nifrajs/island-trigger": patch
"@nifrajs/middleware": patch
"@nifrajs/node": patch
"@nifrajs/pi": patch
"@nifrajs/proxy": patch
"@nifrajs/schema": patch
"@nifrajs/testing": patch
"@nifrajs/ts-plugin": patch
"@nifrajs/web-solid": patch
"@nifrajs/web-vue": patch
"@nifrajs/workers": patch
---

Copied record, hash, hex and regex-escape helpers and a few chained type assertions are replaced by the shared `@nifrajs/utils` helpers and single assertions. The runtime expressions are the same, so behavior does not change.
