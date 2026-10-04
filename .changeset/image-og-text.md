---
"@nifrajs/image": patch
---

`renderOgImage()` and `ogImageResponse()` take CMS-shaped text. Line breaks and tabs are drawn as spaces, an empty optional `description` or `eyebrow` is treated as absent, and text past its limit ends with an ellipsis. Before, each of these threw. A missing title and a control character an SVG cannot hold are still errors.

A revalidation of an unchanged card is answered `304` from the tag this process last sent for the same SVG and rasterizer, without rasterizing again, as documented.
