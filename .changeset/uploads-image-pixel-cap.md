---
"@nifrajs/uploads": patch
---

Reject oversized image dimensions before metadata stripping decodes the source, using the upload pixel limit and a stable `ImagePixelLimitError`.
