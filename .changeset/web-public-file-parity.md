---
"@nifrajs/web": patch
---

The development/production parity check lists a public file by the same percent-encoded URL the build records for it. A build with a public file whose name holds a space or a non-ASCII character (`My Logo.png`, `café.txt`) no longer fails parity.
