---
"@nifrajs/image": minor
---

`wasmImageBackend` now turns a square JPEG upright by its EXIF orientation. It took any quarter-turn image that decoded to its displayed size as already turned by the codec, which a square always does, so square photos were served sideways. `WasmImageCodecs` takes an `orientsJpeg` flag for a decoder that applies the orientation itself; the backend then leaves its pixels alone.
