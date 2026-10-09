---
"@nifrajs/cli": patch
---

The `nifra check` report counts info findings as info, not as advisory: a section reads `⚠ <rule>: 1 (advisory) (+1 info)` or `✗ <rule>: 1 (+1 info)`, and the closing line reads `✓ check passed (1 advisory, 2 info)`. Before, a silenced finding (info) was counted as advisory.
