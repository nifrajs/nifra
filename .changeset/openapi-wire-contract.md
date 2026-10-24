---
"@nifrajs/schema": minor
"@nifrajs/core": minor
"@nifrajs/mock": patch
"@nifrajs/testing": patch
---

`toOpenAPI` describes routes whose schemas come from a library that implements Standard JSON Schema (`~standard.jsonSchema`, as zod 4 does): a request is described by the schema's input side, a response by its output side. A type the library cannot express, such as zod's `z.date()`, leaves that route without detail, as before. `$defs` in such a schema become components, and a `$ref` to the schema's own root points at a component of its own, so every ref resolves inside the document.

Every operation lists the errors the framework answers before its handler runs. A route with a body lists `400`, `413` and `415` as the shared `NifraError` component (`{ ok: false, error }`), and a route with any request schema lists `422` as `NifraValidationError` (`{ ok: false, error: "validation", issues }`, at most 100 issues). The `422` is left out when a route's `onValidationError` hook or the app's `server({ onValidationError })` writes that body. A response the route or contract declares for the same status wins. A user schema whose `$id` matches one of these names gets a component of its own.

A union whose members all require one property and pin it to distinct values (`t.union` of objects tagged by a `t.literal`, or a zod discriminated union) is emitted as a `oneOf` with a `discriminator`, plus a `mapping` when every member is a component.

`t.integer()` is bounded to the safe-integer range by default (`minimum: Number.MIN_SAFE_INTEGER`, `maximum: Number.MAX_SAFE_INTEGER`) and its JSON Schema says so. A JSON body or query value past 2^53 - 1 has already been rounded when it is parsed (`9007199254740993` arrives as `9007199254740992`), so it now fails validation with a 422 instead of reaching the handler as a different number. A bound passed to `t.integer()` replaces the default on that side.

`reflectSchema(value, side)` from `@nifrajs/core/reflection` reads a Standard JSON Schema when the value carries no JSON Schema of its own, on the `"input"` (default) or `"output"` side, and marks the result `converted: true`. Route reflection reads response, error and SSE schemas on the output side, and sets `validationErrorHook: true` on a route whose validation failures an `onValidationError` hook answers; project evidence carries that flag. A tool whose input is such a schema now lists its real input schema instead of an empty object.

`@nifrajs/mock` and `@nifrajs/testing` keep deriving a converted schema through their `reflectJsonSchema` hook, as before. `@nifrajs/mock` treats the safe-integer limits as an open bound, so a `t.integer()` field still mocks a value between 0 and 100.
