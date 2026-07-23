---
"create-nifra": patch
"@nifrajs/core": patch
---

Fix `nifra init-agents`, and explain rejected route parameters.

`nifra init-agents` failed for every installed user with `Cannot find module 'create-nifra/agent-files'`.
The `./agent-files` subpath resolves through the `bun` condition to `src/agent-files.ts`, which the
published tarball did not contain - the package shipped `dist` and the templates only. It now ships
that source file, so the subpath resolves from a real install. Reproduced from a packed 2.1.0 tarball
before and after.

An invalid route parameter now says why. Route grammar is per-segment - a segment is wholly static or
wholly a parameter - so everything after the colon is the name, and `/v/:id.json` asks for a parameter
literally called `id.json`. The previous `invalid parameter ":id.json"` read as a typo rather than a
rule; the message now names the limitation and gives both ways out (`/v/:id/json`, or capture the whole
segment and split it in the handler). Reserved names, an empty name, and a name that is invalid for
some other reason each get their own explanation instead of sharing one.

Note for anyone who has hit this: a segment that merely *contains* a colon without starting with one,
such as `/a/pre-:id`, is a literal static segment and captures nothing. That is deliberate - a colon is
legal inside a URL path segment (`/v1/things:batchGet`) - and is now covered by a test that documents it.
