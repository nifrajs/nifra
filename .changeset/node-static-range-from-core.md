---
"@nifrajs/node": patch
---

`serve`'s `static` reader parses `Range` with the same parser as `@nifrajs/core/range`, `servePublicDir` and the Deno entry, so a seek lands on the same byte on every runtime. Answers that differ from before:

- overlapping or adjacent ranges (`bytes=0-5,3-9`) are served as the one range they cover, `206`.
- a satisfiable range listed with unsatisfiable ones (`bytes=500-,0-1`) is served, `206`.
- the unit is matched case-insensitively and may have spaces around `=` (`Bytes = 2-4`).
- an inverted range (`bytes=9-0`) is `416`; it used to be ignored.
- a zero-length suffix (`bytes=-0`) is ignored and the whole file is sent; it used to be `416`.
- a `Range` longer than 16 KiB is ignored.

`If-Range` is still checked first, so a stale validator still gets the whole file.
