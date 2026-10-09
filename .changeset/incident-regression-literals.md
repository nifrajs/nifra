---
"@nifrajs/testing": patch
---

`generateRegressionTest()` writes the captured method, path and status into the generated test only as escaped string literals. A path containing `"` used to close the `describe()` title and inject statements that ran when the test file was imported. The import path is emitted the same way, and `appExport` must be a plain identifier.
