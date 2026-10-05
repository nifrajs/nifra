---
"@nifrajs/web": patch
---

A static route file beside a dynamic one builds again: `users/me.tsx` next to `users/[id].tsx`, or a
`[lang]/` tree next to `about.tsx`, no longer fails `buildManifest` with "overlapping routes". The path
they share goes to the more specific route, in the router's own order (static, then mixed, then param,
then wildcard, segment by segment), and each keeps the paths only it serves. Two routes of one shape
that share a path, such as `users/[id].tsx` and `users/[slug].tsx`, still fail at boot, because one of
them could never be served.
