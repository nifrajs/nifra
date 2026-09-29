---
"@nifrajs/uploads": patch
---

fix(uploads): signed URLs accept one spelling per signature

`verifyDownloadUrl()` accepts only canonical unpadded base64url signatures. Whitespace, padding, and
alternate encodings of the final character are rejected, so one signature maps to one URL.
