---
"@nifrajs/web": patch
---

The SSR render fast path does less work per request, with byte-identical output. The hydration-head nonce rewrite is skipped when no CSP nonce is set - it was a `.replace` over the whole (constant) hydration script that produced identical output on the common no-nonce path - and the combined deferred-list is reused instead of re-spread into a fresh array on the common page-only render (no layout loader, no action).
