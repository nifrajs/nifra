---
"@nifrajs/image": patch
---

`imageDimensions()` sizes a GIF the way browsers draw it: each side is the larger of the logical screen and the first frame. A GIF whose header declares a 1x1 (or 0x0) screen around a 10x20 frame now reports 10x20. When the first frame lies past the bytes read, the logical screen size is returned as before.
