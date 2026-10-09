---
"@nifrajs/core": patch
---

The email pattern in `commonSecretPatterns` scans a long run of address characters once. A logged value like `a.a.a.` repeated restarted the match at every letter, so 64 KB of it took most of a second to redact. It now starts a match only where such a run starts, and redacts the same addresses (plus a leading `+` or `.` that used to be left in front of one).
