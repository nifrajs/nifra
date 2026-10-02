---
"@nifrajs/web": minor
---

feat: the dev server keeps a feed of errors, logs and requests for coding agents

`nifra dev` (Bun and Vite pipelines alike) records what happened while it ran and serves it to local
tools:

- Errors from every layer, each a structured diagnostic: SSR renders, loaders and actions, backend
  handlers, builds, the browser, hydration mismatches, and a crash of the server itself. Repeats of
  one failure collapse into one entry with a count; an entry recorded before the last file change is
  flagged `stale`, and a build error clears when the next build passes.
- Console output from the server and from the browser.
- One trace per request (method, path, status, duration, bytes, ISR status, its errors and log
  count). Every dev response carries `x-nifra-request-id`, and every entry from that request, server
  or browser, carries the same id.

Each dev page carries a small inline script, first in `<head>`, that reports uncaught errors,
unhandled rejections, failed script and stylesheet loads, console output and errors passed to
`console.error`. Browser stacks are mapped to source through the dev server's own source maps, in
Chrome, Firefox and Safari formats. The script is admitted by hash in a page's CSP (by the page nonce
under Vite) along with its endpoint in `connect-src`; a page whose CSP allows no script gets none.

The server writes `.nifra/dev-server.json` (owner-only) with its port and a per-run token, and a log
under `.nifra/dev-server.log` that outlives a crash. The feed endpoints under `/__nifra/` answer only
a loopback `Host` presenting that token; browser reports need a separate page token and a same-origin
`Origin`, are size-capped and rate-limited. Values of non-public environment variables, keys, tokens,
JWTs and credential headers are redacted before anything is stored. `record: false` on
`createDevServer` / `createViteDevServer` turns the record and the log off. The feed's types, the
discovery record reader and the redacting store are exported from `@nifrajs/web/dev-feed`.

The dev overlay links each recognised error code to its section of the new error codes page. Dev only;
production builds and responses are unchanged.
