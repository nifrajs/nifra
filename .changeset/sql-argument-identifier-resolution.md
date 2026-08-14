---
"@nifrajs/cli": minor
---

The interpolated-SQL rule now resolves a query-call argument identifier to its same-file initializer
before shaping it, so extracting a variable no longer launders a finding. Previously
`` await c.query(`SELECT ... '${input}'`) `` was flagged but the identical hoisted form
`` const q = `SELECT ... '${input}'`; await c.query(q) `` passed clean, because const-resolution
reached consts referenced inside a template but never the argument identifier itself.

Resolution covers const and never-reassigned `let`, at both function-local and module scope, and
follows a chain of identifier initializers transitively. The nearest enclosing binding wins, so a local
never resolves through a shadowed outer name. A resolved dynamic statement is an error exactly as the
inline form is; a static hoisted statement (including a const assembled from other static consts) stays
green. Identifiers that cannot be resolved in-file - parameters, imports, reassigned bindings - are left
unflagged rather than guessed at, so a helper that receives a prepared statement as a parameter is not
falsely accused.

New per-statement escape hatch for the case where a dynamic-looking statement is provably safe (a
generated placeholder list, say): a `// nifra-expect sql-dynamic: <reason>` comment on or directly above
the flagged line silences that one statement. The reason is mandatory - a bare marker with no reason
does not suppress.
