---
"@nifrajs/web": minor
---

A router prefetch now sends `x-nifra-prefetch: 1` (exported as `PREFETCH_HEADER`) beside the data header, and a custom `fetchData` receives `"prefetch"` as its fifth argument when no navigation is waiting on the result.
