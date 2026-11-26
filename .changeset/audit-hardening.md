---
"@nifrajs/core": patch
"@nifrajs/web": patch
"@nifrajs/node": patch
"@nifrajs/node-uws": patch
"@nifrajs/cli": patch
"@nifrajs/middleware": patch
"@nifrajs/coding-agent": patch
---

Honor browser Fetch Metadata on origin-less form writes, block active content and network-path URL bindings in islands, and redact common secret formats in structured log values by default. Tighten Host and secret-comparison diagnostics, fix CLI help and JSON flags, and normalize trusted forwarded IPs. Node now rejects failed listener starts and shares the shutdown promise. The coding-agent host keeps unchanged extensions active across reloads and can retry failed module evaluation.
