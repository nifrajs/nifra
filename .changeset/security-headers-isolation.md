---
"@nifrajs/middleware": minor
---

`securityHeaders` gains opt-in cross-origin isolation knobs: `crossOriginOpenerPolicy`, `crossOriginEmbedderPolicy`, `crossOriginResourcePolicy`, and `permissionsPolicy`. All remain off by default and are declared as static response headers, so the fused native lanes are preserved.
