# @nifrajs/aws-lambda

AWS Lambda adapter for nifra - API Gateway HTTP API (payload v2) and Lambda Function URLs, buffered or streaming, with post-decode body limits and single-site header merging. Dependency-free.

Part of the **[nifra](https://nifra.dev)** full-stack TypeScript framework - one core, five UI libraries, every runtime. Scaffold a new app with `bun create nifra`.

## Install

```sh
bun add @nifrajs/aws-lambda
```

## Use

```ts
// handler.ts - one app per container, built at module scope
import { handle, streamHandle, type LambdaEnv } from "@nifrajs/aws-lambda"
import { server } from "@nifrajs/core"

const app = server<LambdaEnv>()
  .get("/", (c) => c.json({ ip: c.clientIp, requestId: c.env.context?.awsRequestId }))

export const handler = handle(app) // API Gateway HTTP API (v2) + Function URLs
// or, on a Function URL with InvokeMode: RESPONSE_STREAM:
// export const handler = streamHandle(app)
```

How it holds the line:

- **Post-decode body limits.** The body is decoded (base64 or UTF-8) and its real `byteLength` checked against `maxBodyBytes` (default 1,000,000 - match your app's setting if you changed it) *before* a `Request` is constructed. The event's own length claims are never trusted; over the limit answers a flat `413`.
- **One header merge site.** Request headers come from the v2 `headers` map plus the separate `cookies` array in exactly one function; the array is canonical, so a `cookie` key smuggled into `headers` never reaches the app. Response `Set-Cookie` values travel in the result's `cookies` array, one entry each - never comma-joined.
- **Base64 honesty.** Response `isBase64Encoded` is decided by a strict UTF-8 decode of the actual bytes, never by content-type guessing. Binary round-trips exactly; text ships as text.
- **Client IP.** `event.requestContext.http.sourceIp` feeds core's client-IP seam; `X-Forwarded-For` trust stays where it belongs, in the app's `clientIp` server option.
- **Flat errors.** Uncaught failures collapse to the same `{"ok":false,"error":"internal_error"}` 500 as every other nifra runtime - the event is never echoed.
- **Freeze-safe `waitUntil`.** Background work settles before the handler returns, so Lambda's container freeze cannot strand it.

The event and invocation context ride on `c.env.event` / `c.env.context` (type your app `server<LambdaEnv>()`). REST APIs (payload v1) and ALB events are out of scope; API Gateway does not support response streaming - `streamHandle` is for Function URLs.

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
