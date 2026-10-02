---
"@nifrajs/client": patch
---

fix: `ActionData` unwraps `revalidate()` in an action that also returns plain data

An action returning `revalidate(paths, data)` on one branch and a plain object on another now types
`actionData` as the union of `data` and the plain returns. Before, the wrapper itself stayed in the
union, so reading `actionData.ok` failed to type-check.
