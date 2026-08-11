---
"@nifrajs/core": patch
---

A contract operation's client-visible `body` and `query` types are now the schema's INPUT side, not
its output side - matching what the inline registry already does. A schema that fills in defaults
made the contract client demand the post-validation shape, so a caller had to send fields the schema
exists to supply. Handler-facing context types are unchanged and still carry the validated output.
