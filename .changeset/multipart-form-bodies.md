---
"@nifrajs/core": minor
"@nifrajs/schema": minor
"@nifrajs/uploads": minor
"@nifrajs/client": minor
"@nifrajs/edge": minor
---

feat(schema): a route body can be a `multipart/form-data` form with file fields. `@nifrajs/schema/form`
exports a `t` that is the `@nifrajs/schema` builder plus `t.file` and `t.form`; text fields and files
are validated before the handler runs and typed in `c.body`.

```ts
import { t } from "@nifrajs/schema/form"

app.post(
  "/avatars",
  {
    body: t.form({
      avatar: t.file({ maxBytes: 5_000_000, accept: ["image/png", "image/jpeg"] }),
      caption: t.optional(t.string({ maxLength: 200 })),
    }),
    bodyLimit: 6_000_000,
  },
  (c) => ({ bytes: c.body.avatar.size }),
)
```

`@nifrajs/schema`

- `t.file({ maxBytes?, accept? })` validates a `File`. The size is checked before a byte is read.
  `accept` takes exact types and `type/*` wildcards and is matched against the file's leading bytes,
  never the type the client claimed; the validated file then carries the detected type. An `accept`
  entry no signature can prove (`text/csv`, `image/svg+xml`, `*/*`) throws when the schema is built.
- `t.form(fields, options?)` is a route `body` as is. Text fields are coerced from their string form,
  a repeated field is a list, and an undeclared field fails validation unless `additionalProperties`
  is set. `options` also takes the body limits below.
- `t.array(file)` and `t.optional(file)` work with either `t`. `t.object`, `t.looseObject`, `t.query`,
  `t.union`, `t.record`, and `t.paginated` throw when handed a file field.
- A zero-byte file part, or an empty text part in a file field, counts as no file. A required list
  field with no entries is `[]`.
- A form with no required file also accepts `application/json` and
  `application/x-www-form-urlencoded` bodies.
- `toOpenAPI` emits a body with a file field as `multipart/form-data` unless `requestContentType`
  says otherwise.
- `@nifrajs/schema` now depends on `@nifrajs/uploads`.

`@nifrajs/core`

- `@nifrajs/core/multipart` exports `multipartBody(schema, limits?)`, which marks any Standard Schema
  as a form body, and the `MultipartLimits` and `MultipartValue` types. The route reads the form under
  its `bodyLimit` and hands the schema a record of strings and `File`s; a repeated name is an array.
- Limits: `maxFields` (default 100), `maxFiles` (10), `maxFieldBytes` (65536), `maxFileBytes`
  (unbounded below `bodyLimit`).
- Responses: `415 unsupported_media_type` for another content type, `400 invalid_multipart` for a
  body that is not a well-formed form or ends before its closing delimiter, and `413` with
  `payload_too_large`, `too_many_parts`, `too_many_fields`, `too_many_files`, `field_too_large`, or
  `file_too_large`.
- File names have path separators and control characters removed. Field names follow the server's
  `protoPoisoning` policy.

`@nifrajs/uploads`

- `DETECTABLE_MIME_TYPES` and `FILE_TYPE_PREFIX_BYTES` are exported, and `@nifrajs/uploads/detect`
  exports them with `detectFileType` and `FileType` on their own.

`@nifrajs/client`

- A body that holds a `File` or `Blob` is sent as `multipart/form-data`. An array value is sent as a
  repeated field, `null` and `undefined` values are left out, and a caller-set `content-type` is
  dropped so the generated boundary is used. A `FormData` body is sent as is. A nested object or list
  cannot be a form field.
- `inProcessClient` and `testClient` send a `FormData` body with its `content-length`.

`@nifrajs/edge`

- A route whose body is a `t.form` or a `multipartBody` schema reads the form, with the same limits
  and responses as the full server.
