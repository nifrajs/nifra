---
"@nifrajs/uploads": patch
---

`detectFileType` reads an ISO-BMFF `ftyp` box's compatible brands only within `FILE_TYPE_PREFIX_BYTES`, as documented. The box size is the sender's claim, so a crafted upload declaring a megabytes-long `ftyp` box made the detector build a string for every four bytes of the file; the same file also got a different verdict when a caller sniffed only the prefix. A compatible brand past the prefix no longer decides the type.
