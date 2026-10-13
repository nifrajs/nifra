# @nifrajs/runner

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

### Patch Changes

- 50d510f: `runApp()` sends a `ReadableStream` request body on Node, which requires `duplex: "half"` on a streamed `Request`; it failed there with `TypeError: RequestInit: duplex option is required when sending a body.` before reaching the app. Bun, Deno and browsers accepted it already.

## 5.0.0

### Patch Changes

- b77ae4c: `runRequest` sends a `URLSearchParams` body form-encoded with the content type Fetch gives it, instead of encoding it as JSON. A response body whose multi-byte character is split across two chunks now decodes as that character rather than as replacement characters.
- 6ad9582: `runRequest` results keep every `Set-Cookie` value: a new `setCookie` array lists them in order, and `headers["set-cookie"]` joins them as `Headers.get` does instead of keeping only the last one.

## 4.0.2

## 4.0.1

## 4.0.0

### Patch Changes

- 031c33d: fix(runtime): preserve typed-array compatibility across Fetch runtimes and reject invalid request bodies at the runner boundary.

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

## 3.0.0

### Patch Changes

- ee2744c: Runner command responses are now read incrementally and canceled at the configured output limit, so an oversized or non-terminating response cannot be fully buffered before truncation.

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
