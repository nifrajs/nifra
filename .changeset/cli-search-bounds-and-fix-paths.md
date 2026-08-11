---
"@nifrajs/cli": patch
---

The docs, examples, and types MCP searches bound their own cost. A query is truncated to 256
characters and 12 distinct terms before scoring (`MAX_QUERY_CHARS` / `MAX_QUERY_TERMS`), and the
schemas advertise the same 256-character limit. Each bundled corpus is read once per process and its
sections are parsed, tokenized, and lowercased once, instead of on every call - the corpus ships
immutable in a published build, so there is nothing to invalidate.

Auto-fixes write only inside the project. A diagnostic path is rejected when it is absolute, when it
escapes the root lexically, or when its real path lands outside after symlinks resolve; the fix is
skipped rather than applied. Both the generic MCP edit path and the fix recipes share the one
`resolveInsideProject` helper.
