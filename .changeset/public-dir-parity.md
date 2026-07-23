---
"@nifrajs/web": minor
"@nifrajs/cli": patch
---

Serve `public/` in production, not just in dev.

`nifra dev` served a project's `public/` directory; production did not. There was no `publicDir`
concept anywhere - dev got the behaviour for free because the HMR path runs on Vite, and Vite serves
`public/` by default. So a file worked all the way through development and 404'd the moment it was
deployed, and every app had to notice this and hand-roll static serving in its own server entry.

The failure is inverted, which is what makes it expensive: it appears only in production, and only for
the assets nobody smoke-tests. It has already shipped once as a self-hosted webfont that 404'd in prod
and silently fell back to a system font. Nothing errored and nothing alerted.

`publicDir` (default `"public"`) is now a first-class option. The build copies the directory into the
output and records the file list on the build manifest, and `servePublicDir` is exported for a server
entry to mount. Dev routes through the **same** handler rather than inheriting Vite's - two code paths
with different defaults was the whole bug, so there is now one owner.

Behaviour, matching what apps arrived at independently: only paths with a file extension are probed,
so a page route never pays a filesystem stat; a miss falls through to routing, so no route is shadowed;
and cache headers differ by subtree - content-hashed `/assets/*` immutable, `public/` a day, both
overridable. Path traversal is confined by resolving and then verifying containment, rather than
scanning the input for `..` - a blocklist over encodings is the version that gets bypassed - and
percent-encoded and NUL-bearing paths have tests.

Note that `publicPath` is a different thing: the URL prefix for content-hashed bundle chunks. It never
covered user-authored files, and the name similarity actively misleads.

`nifra check` now points out that an app with a `public/` directory can delete its hand-rolled static
serving. A tip rather than a finding - an existing handler still works, since it runs first.
