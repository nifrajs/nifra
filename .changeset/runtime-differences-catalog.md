---
"@nifrajs/cli": minor
---

Add `nifra runtime` and the `nifra_runtime` MCP tool: a symptom-indexed catalog of where Bun, Node, Deno and Cloudflare Workers behave differently under the same app (request-target and Host handling, pipelining, JSON content-type, engine error messages, recursion depth, `.env` loading, and runtime-specific APIs), each with the fix, how to verify it, and the versions it was measured on. The frontend catalog gains entries for React `Activity` hydration, inline-style CSP, and WebKit's handling of streamed module scripts. Documented at `/docs/runtime-differences`.
