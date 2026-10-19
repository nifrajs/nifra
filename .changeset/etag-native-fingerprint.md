---
"@nifrajs/middleware": patch
---

`etag()` fingerprints a body with the runtime's native hash: `Bun.hash` on Bun and node:crypto's one-shot SHA-1 on Node, neither copying a string body first. Deno keeps FNV-1a, now run over the string itself. A JSON `GET` of 2-64 KB through `etag()` costs 1.86-2.31x less CPU on Bun, 1.19-1.54x less on Node and 1.05-1.11x less on Deno. Weak tags change once with this release, so a cached copy is answered with a 200 on its first revalidation after the upgrade; the Bun and Node tags are also wider than the 32-bit FNV-1a they replace.
