---
"@nifrajs/runner": patch
---

`runRequest` sends a `URLSearchParams` body form-encoded with the content type Fetch gives it, instead of encoding it as JSON. A response body whose multi-byte character is split across two chunks now decodes as that character rather than as replacement characters.
