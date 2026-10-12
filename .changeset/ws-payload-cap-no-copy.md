---
"@nifrajs/core": patch
"@nifrajs/deno": patch
---

Checking `wsMaxPayloadBytes` on Deno, and on runtimes wired through `attachWebSocket` (Cloudflare Workers), no longer UTF-8 encodes every text message to measure it: the size is counted in place, and a message whose length alone settles the answer is not scanned at all. Before, each capped text message was copied once just to be measured. The `@nifrajs/deno` docs now state the limit of that check: `Deno.upgradeWebSocket` takes no size limit, so Deno receives each message whole (up to its own 64 MiB on Deno 2.9) before the cap closes the socket with `1009`.
