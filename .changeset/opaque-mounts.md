---
"@nifrajs/core": minor
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

feat: a mount nifra cannot analyze is a declared known gap, not a silent hole. Routes behind
`mount()` and `mountFetch()` are invisible to route reflection, so capability assurance could not
see them and said nothing. Both now take `opaque: "<reason>"`, and so does a `createWebApp`
`mounts` entry. Capability assurance lists a mount with a reason as a known gap
(`report.gaps`, `{ kind: "opaque-mount", path, reason }`): `nifra check` and
`nifra capabilities check` print it on every run, and it fails nothing and lowers no level. A mount
on the analyzed app without a reason fails with the new `opaque-mount-undeclared` finding, which
suggests `merge()` for a nifra `server()` and `opaque` for anything else. A mount whose app publishes
composed evidence (the API `createWebApp` mounts) is not reported. `webProjectEvidence` accepts a
`mounts` entry without an evidence provider when it declares `opaque`. New exports:
`reflectMounts` and `ReflectedMount` from `@nifrajs/core/reflection`, `CapabilityGap` from
`@nifrajs/core/capabilities`; project evidence snapshots gain an optional `mounts` list, absent for
an app with no mounts.
