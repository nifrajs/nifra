---
"@nifrajs/coding-agent": patch
---

`FileSessionStore` keeps token counts. A number under a plural `tokens` key (`usedTokens`,
`windowTokens`, `max_output_tokens`) is a usage count and is stored as written; it was replaced with
`"[redacted]"` along with real secrets. A key whose other words name a secret (`secretTokens`) is
still redacted, and so is any other value under a token-like key.
