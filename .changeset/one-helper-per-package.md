---
"@nifrajs/agent-app": patch
"@nifrajs/agent-protocol": patch
"@nifrajs/cli": patch
"@nifrajs/coding-agent": patch
"@nifrajs/testing": patch
"@nifrajs/web": patch
---

Small helpers that several modules of a package each defined (the object check, RegExp escaping, `\` to `/` path conversion, line lookup) now have one definition per package. No API or behavior change.
