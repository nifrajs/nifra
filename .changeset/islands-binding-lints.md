---
"@nifrajs/cli": minor
---

`nifra check` matches island markup against the code that mounts it:

- NF-C047 (warning): a `data-bind-*` attribute inside a `data-island` host names a signal its `bindIsland` setup never declares with `state("...")`, or a handler the setup does not return. Vanilla `html` templates and JSX (including the `<Island>` marker) are read; a name built at runtime is not judged.
- NF-C048 (warning): a `data-bind-*` attribute outside every island host, or inside a host mounted with `defineIsland` or a plain enhancer, never binds.
- NF-C022 now checks `bindList` from `@nifrajs/web/islands`: a key that reads a second parameter (`bindList` passes none) or hands the item to `indexOf`/`findIndex`. An `indexOf` over the item's own data, such as `u.email.indexOf("@")`, is not flagged.

NF-C021 and NF-C023 are retired: `nifra explain` says so, and the codes are never reused. `nifra scaffold --variant stateful` emits a reactive island (`bindIsland` state, `data-bind-*` markup, keyed `bindList`), and both island stubs put their `data-island-props` JSON in a quoted attribute.
