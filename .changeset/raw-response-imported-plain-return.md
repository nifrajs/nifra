---
"@nifrajs/cli": patch
---

NF-C007 no longer reports a route handler whose plain return is a call to an imported function, such as `if (!id) return new Response("bad", { status: 400 }); return toShelfRow(id)`. The call keeps the route typed unless the imported module, read from the project, returns a `Response`.
