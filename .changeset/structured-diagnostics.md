---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

Errors resolve to a structured diagnostic - one object a person reads in the overlay and an agent reads as JSON.

The dev error overlay now shows a source codeframe around the offending line and, for failures nifra recognises (a server-only module or a `node:` built-in reaching the client, a schema mismatch), a plain-language cause and fix with a docs anchor. A new `@nifrajs/web/diagnostic` export builds that `Diagnostic` - stable `code`, the top frame in your own source, the codeframe, and the cause/fix - from any thrown value, and the dev server serves the most recent one as JSON at `/__nifra/last-error`.

`nifra_explain` (MCP) turns an error - pasted from `nifra_run`/`nifra_test` output, or the dev server's last - into that same diagnostic, so an agent gets the code, the codeframe in your source, and the fix instead of eyeballing a stack trace.
