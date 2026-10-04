---
"@nifrajs/core": minor
---

A group's `use()` of a plugin its parent server already applied throws a `RouteConfigError` with code `PLUGIN_RECONFIGURED` when it passes another instance under the same name - another `cors()` policy, a second `bearer()` verifier - where it used to skip it, so a group no longer appears to apply a configuration that never runs. Passing the parent's own instance is still a no-op, and a plugin the group applies still shares the parent's copy of a plugin it `use()`s itself. Plugins that name each instance, such as `rateLimit()`, `bodyLimit()`, `csrf()` and `securityHeaders()` with its own configuration, already apply inside a group and are unaffected.
