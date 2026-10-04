---
"@nifrajs/uploads": patch
---

`detectFileType()` recognizes an AVIF whose major brand is the generic `mif1`, `msf1` or `miaf` by the `avif` among its compatible brands, a `msf1` HEIF image sequence, and an MP3 without an ID3 tag by its MPEG audio frame header. AAC's ADTS header is not mistaken for one. `FILE_TYPE_PREFIX_BYTES` is now 32, enough to reach those brands.
