# @nifrajs/uploads

File-upload hardening for nifra - size + magic-byte type validation, short-TTL signed download URLs, and EXIF/metadata stripping. Edge-safe.

Part of the **[nifra](https://nifra.dev)** full-stack TypeScript framework - one core, five UI libraries, every runtime. Scaffold a new app with `bun create nifra`.

## Install

```sh
bun add @nifrajs/uploads
```

## With a schema

`validateUpload` is for a route that reads the upload itself. To declare the file in the route's
body schema instead - validated before the handler runs, typed in `c.body` - use `t.file` and
`t.form` from `@nifrajs/schema/form`, which run the same signature detection.

For code that needs file-type detection and nothing else, import `detectFileType`,
`DETECTABLE_MIME_TYPES`, `FILE_TYPE_PREFIX_BYTES` and the `FileType` type from
`@nifrajs/core/file-type`.

## Docs

- Reference: <https://nifra.dev/docs>
- AI-readable: <https://nifra.dev/llms.txt>

MIT

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
