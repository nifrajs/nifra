---
"@nifrajs/cli": minor
---

`nifra contracts snapshot` records each part a route declares (body, query, params, headers, cookies,
response, sse and each error status) with its own digest and its top-level fields, and warns for each
part whose declared schema it cannot read, which the lock records as `null` and so never guards.
`nifra contracts check` and the `nifra check` contract gate catch a change to a headers or cookies
schema, name the side, the part and the fields that moved (`body + id: number, - name: string`),
name a route that was added or removed, and report a part the lock recorded as `null` as newly
covered, with the snapshot to run, rather than as a change. A lock written before parts were recorded
keeps comparing by side until the next snapshot, and an older CLI reads the new lock as before.
`nifra contracts check --out <file>` reads that lock. `nifra upgrade` notes the locked routes that
send a body but record no request schema.
