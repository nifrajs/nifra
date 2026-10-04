---
"@nifrajs/image": minor
---

Images are sized and served the way a viewer displays them, with a JPEG's EXIF orientation applied:

- `imageDimensions()` and `readImageDimensions()` report a JPEG's displayed size. An `<Image>` of a phone photo stored landscape with orientation 6 now gets portrait `width`/`height`.
- `sharpImageBackend()` turns the pixels upright before resizing (sharp's `rotate()`), and its probe reports the displayed size. Before, every resized or metadata-stripped photo with an orientation tag came out turned. `SharpLike` now includes `rotate()`.
- `wasmImageBackend()` turns the decoded pixels upright before resizing and encoding. A codec that already turned a quarter-turn image is left as it is.
