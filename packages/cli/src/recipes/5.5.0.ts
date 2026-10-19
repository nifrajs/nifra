import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.5.
 *
 * No import moves. An app on the server-component pipeline moves its React stack to 19.3.1 together;
 * each note says what an app or a client sees differently.
 */
export const recipe: UpgradeRecipe = {
  version: "5.5.0",
  pins: [
    { match: "@nifrajs/", to: "5.5.0" },
    { match: "create-nifra", to: "5.5.0" },
    { match: "nifra", to: "5.5.0" },
    { match: "react-server-dom-webpack", to: "19.3.1" },
  ],
  importMoves: [],
  notes: [
    "The server-component pipeline is certified on React, React DOM and `react-server-dom-webpack` 19.3.1 with Vite 8.2.1. `react-server-dom-webpack` is pinned here; set `react` and `react-dom` to exactly 19.3.1 as well. Until all three match, the plugin's guard stops the build and `nifra check` names each installed version. On Bun, server components need Bun 1.3.14 or later: earlier 1.3 releases cannot parse React 19.3.1's server renderer.",
    "Workbench loads a project's `.nifra/extensions/**` only when started with `--extensions`, as `nifra-agent` does. A Pi-backed session without the flag runs no project extension code; pass it only for a repository you trust.",
    "An idempotent route that authenticates first runs its `authenticate()` stages before the idempotency key is checked or the body is read, so a bad credential gets the route's `401` without buffering the body. The dedupe step runs under `requestTimeoutMs` and answers `503` when the resolver or store stalls, and a different payload under a used key answers `409 idempotency_key_reused` instead of replaying the first response.",
    "A response `transportCodecs()` negotiates carries `Vary: Accept`, and `cache()` stores it only when its `vary` includes `accept`. A request the codecs decode keeps the body and `Content-Type` it was sent with, so a route without a body schema reads the payload itself from `c.req` instead of a `{}` stand-in. `compression()` adds `Vary: Accept-Encoding` to an identity response it would have gzipped for another client.",
    "`stripImageMetadata()` refuses a source larger than `maxPixels` (default 40 MP) before decoding it, throwing `ImagePixelLimitError`; answer it with `413`. `signDownloadUrl()` throws a `RangeError` for an `expiresInSeconds` that is not a whole number of seconds of at least 1, where it used to sign a link that never verified.",
    "A store-backed session loaded before a logout or rotation is never written back by that request's `commit()`: a loaded session commits only while its record exists and no revocation marker names it. A custom `SessionStore` may implement the new optional `replace(id, record)`, an atomic write only while the record exists that also sets its expiry, and renewals then go through it; a store without it must keep each revocation marker until its `expiresAt`. `regenerate()` now issues the original ID, `~` and a new random part, and logout with any generation's cookie revokes them all: a custom store keeps every `<id>.revoked` and `<id>.rotated` marker until its `expiresAt`, and may implement the optional atomic `rotate(previousId, nextId, record, marker)`.",
    "A static file over 256 KiB streams without an automatic `ETag`. Once its last change is more than 2 seconds old it revalidates by `Last-Modified`, and a `Range` request guarded by `If-Range` gets the whole file. Smaller files keep their content `ETag`.",
    "`AgentAppClient.send()` and `HttpAgentTransport.stream()` reject with `AgentTurnError` when the host ends a turn with its `error` frame, where the turn used to complete as a success. A throwing `authorize()` callback rejects with `authorize() failed` and none of its own message.",
    "`createMemoryAgentEvidenceLog` keeps at most `maxEvidencePerTurn` items per turn (default 1024) across every resume of it, and a reconnect whose `Last-Event-ID` is older than what it holds answers `409 replay_unavailable`. `IsolatedExtensionWorker.start()` rejects when the worker exits before it is ready or is not ready within `startTimeoutMs` (default 30 s).",
    "The generated service worker fails its install when a precache response is an error, a redirect, or `Cache-Control: private` or `no-store`, and a runtime cache miss skips a `private` response. A client navigation to a prerendered path with a query string fetches its data from the server instead of the static `_data.json`.",
    "The compact edge server answers a body validator that throws and a handler value that cannot be serialized (a `BigInt`, a circular object) with the flat `500 internal_error`, as the full server does, where `fetch()` used to reject. `run_query` in `@nifrajs/mcp-db` answers a SQLite INTEGER past 2^53 as its exact decimal string.",
  ],
}
