---
"@nifrajs/web": patch
---

`loadGoogleFont` refuses a stylesheet whose `font-weight` is not a number, a variable range or a keyword. The weight is part of the self-hosted file's name, so a tampered stylesheet could otherwise name a file outside `outDir`.
