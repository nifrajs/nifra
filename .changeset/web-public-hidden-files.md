---
"@nifrajs/web": patch
---

A build no longer copies hidden files from `public/` - any path segment starting with `.` other than `.well-known`, such as `.env`, `.git/` or `.DS_Store`. Development never served them, but the build copied them and every target then served them: the Bun, Node and Deno entries from their allowlist, the static, Pages and Vercel hosts from the directory. The development parity check lists public files by the same rule, and `servePublicDir` also refuses a visible name whose real target is hidden.
