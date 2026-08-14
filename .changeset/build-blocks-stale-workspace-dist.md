---
"@nifrajs/cli": minor
---

`nifra build` now fails when a workspace-linked dependency ships a `dist` artifact that is missing or
older than its source. The `"bun": "./src"` / `"default": "./dist"` conditional-export split lets Bun
(the build, the tests) read live source while the deployed app and any Node consumer read `dist`, so a
green build could bundle stale or absent compiled output and nothing in a diff would show it. The check
runs after the compile proves the source is buildable and names each offending package so the fix
(rebuild it) is obvious. It is a no-op outside a workspace, since a tarball-installed dependency cannot
drift. The doctor already surfaces the same skew as a development-time advisory; at build time it is now
a hard failure, because that is the artifact that ships.
