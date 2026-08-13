---
"@nifrajs/core": patch
"@nifrajs/middleware": patch
"@nifrajs/web": patch
---

Harden three regex-adjacent input paths against pathological input. The byte-range parser bounds an
oversized `Range` header before the matcher runs rather than after; the problem-details type builder
strips trailing slashes with a linear scan instead of a backtracking pattern; and the dev SSR
import-graph specifier pattern no longer has an ambiguous whitespace group. Behavior is unchanged for
valid input.
