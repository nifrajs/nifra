---
"@nifrajs/webmcp": patch
---

`registerWebMcpTools()` keeps refusing a duplicate tool name after a registration in the same call failed. A host refusal for the first capability used to drop the target's name record while later capabilities in that call registered into it, so registering one of them again reached the host a second time instead of failing as a duplicate.
