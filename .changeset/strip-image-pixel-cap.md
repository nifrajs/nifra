---
"@nifrajs/uploads": patch
---

`stripImageMetadata()` now refuses a source larger than `maxPixels` (width x height, default 40 MP, the same as `createImageHandler`) before the backend decodes it, throwing the new `ImagePixelLimitError` - answer it with a `413`. A small compressed upload that passes `validateUpload()`'s byte cap can declare an image that decodes to hundreds of megabytes; the cap is checked against the probed header, so it never reaches the codec. A backend that probes zero, negative or non-integer dimensions is refused with a `TypeError`.
