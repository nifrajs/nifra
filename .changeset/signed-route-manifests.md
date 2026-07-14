---
"@nifrajs/core": minor
"@nifrajs/cli": minor
---

Add a deterministic versioned Nifra manifest that joins route schemas, assurance evidence,
capabilities, and field-level response classification in one hash-verified artifact. Manifests can be
signed through an operator-provided Ed25519 KMS/HSM callback; Nifra never handles private keys.

`nifra manifest emit` refuses failing assurance and writes byte-stable output, while
`nifra manifest diff <before> <after>` hash-verifies both artifacts and fails deployment promotion on
breaking contract, lost assurance, expanded effects, or increased data sensitivity.
