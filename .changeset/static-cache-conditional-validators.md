---
"@nifrajs/node": patch
"@nifrajs/web": patch
---

Static files on Bun and Deno evaluate `If-None-Match` before `If-Modified-Since`, including the wildcard condition for an existing file. A stale entity tag can no longer produce a `304` from its accompanying date.

The Node static reader no longer generates an ETag or Last-Modified date from an unknown or zero modification time. Replacing a file with the same size in a deployment that normalizes timestamps therefore sends the new content instead of validating an obsolete copy or resuming it with incompatible bytes. Explicitly configured validators still apply.
