---
"@nifrajs/web": patch
---

The build's credential scan no longer reports a translated field label or a documentation placeholder as a secret assigned to a secret-like name. A word-cased label (letters, marks and hyphen-joined words, such as `"Undirskriftar-Lykill"`) inside a top-level object literal that reads as a message catalog (at least ten string values, most of them prose with whitespace) is a label, and a value with a whole `_`/`-` segment such as `your`, `example`, `placeholder`, `sample`, `dummy`, `changeme`, `replace`, `generated` or `xxx` is a stand-in. Both apply only to the assigned-secret rule: a key format, a private key, a credential URL or the value of a private environment variable still fails the build wherever it is, and random data under a catalog key is still a finding.
