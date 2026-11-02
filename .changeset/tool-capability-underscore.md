---
"@nifrajs/core": minor
---

A capability id joins lowercase segments with `.`, `-` or `_`, so the capability `defineTool` derives, `tool.execute.<name>`, is valid for a snake_case tool name such as `archive_notes`, and a grant of it runs the tool. Before, that derived id failed the capability grammar, and the tool was denied unless it named its own `capability`. The grammar is the same wherever a capability id is read: route and socket `capabilities`, execution-policy ceilings, the effect ledger, assurance policies and manifests. A tool name with an empty segment (`a__b`, a trailing `-`) derives no valid id, and `defineTool` refuses it unless `capability` is passed, rather than returning a tool no grant can run.
