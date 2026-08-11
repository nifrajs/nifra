---
"@nifrajs/core": minor
---

`merge()` now scopes a group's `onRequest` hooks to the group's own routes, following the same locality rule its `derive`/`beforeHandle` chains already obey: a `bodyLimit()` mounted on an uploads group no longer starts gating every route of the app that composes it in. The guard is a single route probe against a snapshot of the group's catalog, so requests outside the group pay one lookup and pass untouched; the group's Node-native hook twins are scoped the same way. Global assurance declared by a group's middleware follows the enforcement - it is folded onto exactly the merged routes, so `routes()` never claims a group's protection for parent routes its hooks do not see.

A group with hooks but no routes is a middleware bundle: its hooks can only mean app-wide intent, so they are still appended globally, unchanged. Apps that relied on a route-carrying group's hooks running app-wide should register that middleware on the parent server with `.use()`.
