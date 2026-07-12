---
"@nifrajs/budget": minor
"@nifrajs/core": minor
---

Add portable absolute request deadlines with monotonic remaining time, child reserves, strict wire
parsing, and local-policy admission. Nifra handlers now receive the admitted budget as `c.budget`; it
shares the existing `c.signal`, clamps hostile far-future deadlines, and distinguishes malformed,
expired, and exhausted inherited deadlines.
