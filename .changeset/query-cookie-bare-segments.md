---
"@nifrajs/core": patch
---

Reading `c.query` or the request's cookies takes time linear in the query string or `Cookie` header, including when it holds many segments without an `=` (`?a&a&a...`, `a; a; a...`). Each such segment searched for `=` through the rest of the input, so a long run of them cost time quadratic in its length. `hasDuplicateCookie` scans the same way. Parsed values are unchanged.
