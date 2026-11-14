---
"@nifrajs/cli": patch
---

`nifra mcp` no longer buffers an unbounded line from a project CLI it hands a session over to. A message larger than 16 MiB, or a line that never ends, stops that CLI and answers the waiting request with an error instead of growing the server's memory. The shared line reader now reports an oversized line as soon as it crosses the limit, not when its newline arrives.
