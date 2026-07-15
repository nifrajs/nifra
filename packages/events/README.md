# @nifrajs/events

Portable, versioned event contracts — a typed, transport-agnostic event envelope validated by any Standard Schema.

An envelope may carry the bounded `@nifrajs/core/causality` context for its exact event id. Creation
and parsing reject mismatched nodes and unknown fields, so arbitrary payloads cannot hitchhike in the
lineage metadata.

See the [nifra docs](https://github.com/nifrajs/nifra#readme).
