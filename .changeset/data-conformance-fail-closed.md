---
"@nifrajs/testing": patch
---

`runDataAdapterConformance` no longer certifies an adapter that breaks three of its guarantees:

- **cancellation** passed on any error, because the signal it checked had always been aborted. It now needs an abort error, and the cancelled row must not be stored.
- **pagination** passed when every page was empty. The pages must now return exactly the rows a read of the scope returns.
- **backup-restore** passed when restore deleted everything. Both scopes must now hold exactly the rows they held at the snapshot.
