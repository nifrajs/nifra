---
"@nifrajs/core": patch
---

A group's `use()` of a plugin its parent server already applied is skipped by name, so a differently configured instance - a stricter `securityHeaders()`, another `cors()` policy - never replaced the parent's. Development builds now warn when that happens, naming the group and the skipped plugin. Production builds are unchanged.
