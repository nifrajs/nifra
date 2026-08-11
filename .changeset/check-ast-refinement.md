---
"@nifrajs/cli": minor
---

`nifra check`'s text-scanning rules confirm their candidates against a parsed source model before
reporting. A route path spelled inside an ordinary string, a `return new Response(` written in a
comment or template text, and an erased inline `import { type X }` no longer produce findings that
a reader has to dismiss by hand.

The parser is a refinement, never a relaxation: it is invoked lazily - only once a lexical scan
finds something worth disambiguating - the parse is cached across rules for the run, and a file that
fails to parse keeps its lexical finding so the security rules stay fail-closed.
