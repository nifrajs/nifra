---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/middleware": patch
"@nifrajs/schema": patch
"@nifrajs/auth": patch
"@nifrajs/image": patch
"@nifrajs/uploads": patch
"@nifrajs/web": patch
"@nifrajs/i18n": patch
"create-nifra": patch
"@nifrajs/cli": patch
---

Trailing trims, base64 padding strips and a few parsers run in time linear in their input. `parseByteRange` reads the range set after `bytes=` without its two quantifiers trading spaces, the srcset reader in server components, the keep-alive `:has(> ...)` check, the OpenAPI `$defs` reference reader and the build secret scan's credential-URL check no longer backtrack over a long run of one character, and a trailing run of slashes, dashes, commas, semicolons, underscores, newlines or `=` padding is stripped without retrying the run at every position.
