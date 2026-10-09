---
"@nifrajs/cli": minor
---

`nifra check` reports NF-C030 (a loader or action without its output schema) as an error when the
function's own body returns a data literal: an object, array, string, template, number or boolean,
as an expression body or a `return` of the function itself, including one inside `if`, `else`,
`for`, `while`, `try` or a `switch` case. The runtime refuses every request that reaches such a
return. A `return` inside a nested function, method, class or braced `case` block, and any
expression whose value the source does not show (a call, a variable, a ternary), keep the warning.
