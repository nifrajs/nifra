---
"@nifrajs/cli": minor
---

`nifra check`'s interpolated-SQL rule now resolves same-file constants. A module-scope `const` interpolated into a query - the shared column-projection idiom (`const COLS = "id, name"` ... `` `SELECT ${COLS} FROM ...` ``), a `const LIMIT = 50`, a const built from other consts, or a ternary whose branches are both literal - is compile-time text and no longer flags, with zero suppression config. Resolution is pure syntax with a depth cap: imported names, `let`, parameters, call results, member accesses, and shadowed names (including a hoisted `var` anywhere in the enclosing function) stay flagged exactly as before, and a resolved const still feeds the SQL-keyword scan, so hostile statement text in a const alongside a dynamic span is still caught. The named escape hatches (`unsafe`, `$queryRawUnsafe`) keep flagging statement-from-variable regardless.
