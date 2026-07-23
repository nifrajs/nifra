---
"@nifrajs/cli": minor
"@nifrajs/web": patch
---

`nifra_types` collapses oversized declarations in search results, and a bad `clientModule` says so.

**`nifra_types` query mode.** A search returned the complete declaration of every match, and the corpus
is wildly uneven: the median symbol is small while `Server` alone is ~32,000 characters, five times the
next largest. One broad query that happened to match it returned the entire class for near-zero value.

A `query` now returns a one-line summary plus the signature, collapsing an oversized body to its head
and a member count, and saying which `name` call returns the rest. Measured on the real corpus:
`"server"` drops from 36,355 to 1,739 characters (95%), `"route schema"` by 87%, `"rate limit"` by 69%.

An exact `name` lookup is **never** collapsed - there the caller asked for that symbol. Pass
`full: true` to opt a query back into whole declarations.

**`clientModule`.** The option is a module specifier resolved by the bundler, so nothing type-checks
that the module actually exports `mountRouter`. A self-executing client entry therefore built cleanly
and failed at first paint with `mountRouter is not a function`, from inside a bundled chunk, naming
neither the module nor the requirement - diagnosable only by reading `build.ts`.

The generated bootstrap now throws immediately, naming the offending specifier, the missing export, its
call signature, and the specific trap that a self-executing entry will not work. The contract is also
spelled out on the option's own type rather than in a parenthetical.
