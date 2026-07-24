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

On Cloudflare Pages the copied files are named individually in `_routes.json` so the CDN serves them
without invoking the worker, within Cloudflare's cap of 100 include+exclude rules of at most 100
characters each. An ordinary `public/` of icons, fonts and share images clears that cap, and the
rejection lands at `wrangler pages deploy` - after a build that reported success.

Past the cap a directory is compacted to one `/dir/*` rule, but only after checking it against the
app's real route patterns. The glob does not merely describe today's files; it hands Pages every future
path under that prefix, so a `public/blog/hero.png` beside a `/blog/:slug` route would send
`/blog/my-post` to a CDN that has no such file and 404 the page in production only. A directory
therefore collapses only when no route can be served beneath it, and a single route with a dynamic
first segment (`/:locale/…`) disables collapsing everywhere, since it can match under any name. A
collapsed directory does give up the app's 404 page for a missing file beneath it - the right trade for
a directory of static files, where a missing image should fail as a fast CDN 404 rather than an HTML
error page.

Whatever still does not fit is dropped rather than widened, which is safe because the list is only an
optimization: the emitted worker serves any path it recognises through the `ASSETS` binding, so an
omitted file costs one worker invocation rather than a 404, and nothing else reaches that binding. The
build prints how many it left out, since a cap you cannot see reads as coverage you do not have.
