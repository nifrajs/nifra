---
"@nifrajs/auth": patch
"@nifrajs/core": patch
"@nifrajs/storage": patch
"@nifrajs/web": patch
---

Log request metadata by default in production. Set `errorLogDetail` explicitly to include error text or stacks.

Rotate store-backed session IDs when a configured `identity` field changes.

Cap buffered R2 reads at 16 MiB by default. Use `maxReadBytes` to set the limit for your bucket.
