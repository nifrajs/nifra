---
"@nifrajs/web": patch
---

`revalidateEndpoint` refuses a JSON purge body over 1 MiB with `413 body_too_large`, counting bytes as the body streams in, instead of buffering whatever the caller sends.
