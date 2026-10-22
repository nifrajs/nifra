---
"@nifrajs/core": minor
"@nifrajs/uploads": minor
"@nifrajs/schema": patch
---

`@nifrajs/core/file-type` exports the magic-byte detector: `detectFileType`, `DETECTABLE_MIME_TYPES`,
`FILE_TYPE_PREFIX_BYTES` and the `FileType` type. It imports nothing and stays out of the
`@nifrajs/core` entry. `t.file({ accept })` in `@nifrajs/schema/form` and `validateUpload` in
`@nifrajs/uploads` both judge a file by it.

`@nifrajs/uploads` exports `validateUpload`, the signed download URLs and `stripImageMetadata`; the
detector's names are imported from `@nifrajs/core/file-type`, and the `@nifrajs/uploads/detect`
subpath is gone. `@nifrajs/uploads` takes `@nifrajs/core` as a peer dependency.

`@nifrajs/schema` depends on `@sinclair/typebox` alone, with `@nifrajs/core` as its peer.
