---
"@nifrajs/cli": patch
---

`nifra_test` keeps only the first 4,000 and last 8,000 characters of a test run's output as it reads, instead of holding all of it before trimming, so a run that prints hundreds of megabytes no longer grows the MCP server's memory with it. When output was dropped, the result marks where and how many bytes were left out.
