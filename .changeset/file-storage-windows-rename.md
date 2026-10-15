---
"@nifrajs/storage": patch
---

On Windows, two `FileStorage` puts of one key at once both succeed again, last writer wins: Windows refuses a rename onto a file while another rename replaces it (`EPERM`, `EACCES`, `EBUSY`), so that rename is now retried for up to about 0.6 s.
