---
"@nifrajs/coding-agent": patch
---

`FileSessionStore` reads a directory written by `nifra-agent --migrate-session`: each migrated record comes back as a content-free entry whose type is its stable event code, and the next append continues the sequence. Before, the store read the migrated history as empty and restarted at sequence 0.
