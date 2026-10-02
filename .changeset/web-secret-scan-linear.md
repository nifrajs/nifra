---
"@nifrajs/web": patch
---

The build's credential scan stays fast on a long unbroken run of letters and digits, such as an inlined base64 asset, instead of slowing the build to minutes.
