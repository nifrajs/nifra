---
"@nifrajs/core": minor
---

Add `@nifrajs/core/wire`: a rich-type JSON codec (`encode` / `decode` / `stringify` / `parse`) for RPC
bodies, loader payloads, and WebSocket frames.

Plain `JSON` drops `undefined`, stringifies `Date`, nulls `NaN`/`Infinity`, loses `-0`, throws on
`BigInt`, and has no notion of `Map`, `Set`, `RegExp`, `URL`, `ArrayBuffer`, or typed arrays - so a
typed client can receive a runtime value whose shape diverges from the type it inferred from the server.
The codec round-trips all of those exactly, preserves shared-reference identity, and encodes cycles as
back-references instead of throwing. Malformed input decodes to a typed `WireDecodeError`; functions and
symbols are rejected on encode rather than silently dropped.
