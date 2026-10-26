---
"@nifrajs/agent": patch
"@nifrajs/agent-review": patch
"@nifrajs/cli": patch
"@nifrajs/coding-agent": patch
"@nifrajs/core": patch
"@nifrajs/image": patch
"@nifrajs/testing": patch
---

More helpers that several modules of a package each defined (SHA-256 to hex, the control-character check, code-unit string order, the child-process environment allowlist, realpath with a fallback, the MCP worker's console redirect and reply line) now have one definition per package. No API change. The `git diff` that `@nifrajs/coding-agent` runs now inherits `CI` like its other child processes.
