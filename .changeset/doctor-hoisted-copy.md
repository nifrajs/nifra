---
"@nifrajs/cli": patch
---

`nifra doctor` also probes the workspace root for identity-sensitive packages, so it reports the split
where every declaring package resolves one physical copy and the root holds another. Consulting only
the packages that declare the dependency saw a single copy and stayed quiet.
