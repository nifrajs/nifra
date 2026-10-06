# @nifrajs/uploads

## 4.0.1

## 4.0.0

### Minor Changes

- 7bfa25e: feat(schema): a route body can be a `multipart/form-data` form with file fields. `@nifrajs/schema/form`
  exports a `t` that is the `@nifrajs/schema` builder plus `t.file` and `t.form`; text fields and files
  are validated before the handler runs and typed in `c.body`.

  ```ts
  import { t } from "@nifrajs/schema/form";

  app.post(
    "/avatars",
    {
      body: t.form({
        avatar: t.file({
          maxBytes: 5_000_000,
          accept: ["image/png", "image/jpeg"],
        }),
        caption: t.optional(t.string({ maxLength: 200 })),
      }),
      bodyLimit: 6_000_000,
    },
    (c) => ({ bytes: c.body.avatar.size })
  );
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

### Patch Changes

- 3bb014f: fix(uploads): signed URLs accept one spelling per signature

  `verifyDownloadUrl()` accepts only canonical unpadded base64url signatures. Whitespace, padding, and
  alternate encodings of the final character are rejected, so one signature maps to one URL.

- 3f8fa2b: `detectFileType()` recognizes an AVIF whose major brand is the generic `mif1`, `msf1` or `miaf` by the `avif` among its compatible brands, a `msf1` HEIF image sequence, and an MP3 without an ID3 tag by its MPEG audio frame header. AAC's ADTS header is not mistaken for one. `FILE_TYPE_PREFIX_BYTES` is now 32, enough to reach those brands.

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

### Patch Changes

- 7551709: Harden runtime boundaries and defaults: clean up subprocess abort listeners, support short Cloudflare
  KV sessions, bound and incrementally sweep the default memory cache, make image reads and cancellation
  safe, emit content-derived image validators, require trusted forwarded hosts, avoid caching dynamic SSR
  metadata, and reject invalid upload or image limits.

## 3.1.0

## 3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0

## 2.0.0

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

## 1.0.0-beta.4

## 1.0.0-beta.3

## 0.1.0-beta.2
