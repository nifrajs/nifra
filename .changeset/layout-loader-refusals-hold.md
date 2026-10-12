---
"@nifrajs/web": patch
---

A layout loader's refusal now holds on every request under it. Three ways around it are closed:

- A client navigation's retain hint (`x-nifra-retain` with `x-nifra-from`) no longer skips a layout loader. Any request could send that hint, so an anonymous caller could skip an admin layout's `throw redirect("/login")` and still receive the page loader's data. The loader now runs on every request, and the browser still keeps its copy when the layout's params and the query are unchanged. Only the layout's own `shouldRevalidate` returning `false` skips the loader; a layout that exports it is not an authorization boundary.
- Layout loaders run before an action, so a layout that refuses also stops the mutation. Until now, a JavaScript submit ran only `gate` layouts before the action, and a no-JavaScript submit ran the other layout loaders only afterwards.
- A layout loader that returns `redirect()` or a `Response` refuses the request the same way a thrown one does. A returned one used to be sent as layout data next to the page's data.

Performance: the retained layout loaders now run again on each client navigation, and layout loaders run one extra time per action. To skip a layout loader whose data does not guard anything, export `shouldRevalidate`.
