---
"@nifrajs/cli": minor
---

The interpolated-SQL rule reads the syntax tree, and TypeScript is an optional peer rather than a
dependency.

The rule used to work on text, which meant guessing where strings and comments began and ending up
lenient in the direction that matters: EVERY tagged template was treated as parameter binding, so
`String.raw` or any no-op custom tag hid an interpolated statement from the check. It now parses with
the compiler and trusts only `sql` and `Prisma.sql`. It also reads a concatenated statement built
across `+`, and skips a file the parser could not read rather than turning recovery nodes into a second
misleading diagnostic.

Trust is by NAME, and that is the honest limit of a scanner that reads syntax and runs no type checker:
`sql` is what postgres.js, drizzle, slonik and Bun's driver all call theirs, and nothing here can prove
a given `sql` binds anything. A no-op function with that name is trusted too. The rule finds mistakes,
not an adversary who has read it - deciding otherwise needs a type checker, which is a different tool.
Names earn their place on that list by being what drivers already call the thing.

The compiler is a ~25 MB install, and the CLI's own typecheck step already treats `tsc` as something
the project provides. Forcing it on every install to run one rule was the wrong trade, so it is an
optional peer resolved when the rule runs. Every Nifra project has TypeScript - the templates all ship
a `typecheck` script - so this resolves in practice.

When it does not, `nifra check` says the rule did not run and how to enable it. That part is not
cosmetic: an empty result is indistinguishable from a clean one, and for this rule a clean result means
"no SQL injection was found". Silence there is the one answer it must never give.
