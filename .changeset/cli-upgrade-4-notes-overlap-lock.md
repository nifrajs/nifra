---
"@nifrajs/cli": patch
---

`nifra upgrade` to 4.0 notes two more changes an app may hit. Page routes of one shape that share a
path fail with "overlapping routes", and same-method backend registrations that accept a shared path
are reported (NF-C024). `contracts.lock.json` also needs one `nifra contracts snapshot`: a route whose
schema has a property named `description`, `title`, `default`, `example` or `examples` gets a new
digest, because earlier digests skipped those properties.
