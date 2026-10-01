---
"@nifrajs/web": patch
"@nifrajs/cli": patch
---

fix(cli): duplicate-install findings name a copy reached through a symlink out of its install

When an importer reaches a copy of an identity-sensitive package through a symlink that points
outside its own install (another project's `node_modules` linked into a shared package, or a
`bun link`), `nifra doctor` prints a `links:` line with each link and its target, and the
`nifra check` duplicate-install diagnostic names the link on that copy and lists it ahead of both
fixes. The identity preflight carries it as `copies[].links` and `provenance`. Package-manager store
links inside an install are not reported.
