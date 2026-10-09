---
"@nifrajs/core": patch
---

In development, `mount()` refuses an app that leads back to the mounting one without `stripPrefix` (itself, or a chain of mounts whose prefixes overlap) with a `RouteConfigError` coded `MOUNT_CYCLE`. A request under that prefix used to come back to the same app unchanged until the stack overflowed, which ended the process. Production bundles drop the check, as they do the other dev-time diagnostics.
