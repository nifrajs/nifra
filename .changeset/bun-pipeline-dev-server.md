---
"@nifrajs/web": minor
---

`@nifrajs/web/dev` runs on Bun's native HMR, so the Bun pipeline no longer needs Vite anywhere.

nifra has two dev pipelines and one rule between them: a pipeline owns a whole phase. The Vite server
stays the default and now resolves SSR as well as the client, so both halves agree on every specifier.
This is the other half of that split. `Bun.serve` bundles and hot-reloads the client, Bun's runtime
resolves SSR, and only one toolchain is present - so the two cannot disagree. Previously this server
rebuilt the whole client and forced a full page reload on every save; now Bun rebuilds incrementally and
pushes over its own HMR socket.

Joining the two halves takes some care, because Bun's dev server bundles HTML routes and nifra renders the
document itself. A throwaway HTML route exists purely so Bun bundles the generated client entry and
assigns it a URL, which nifra reads back and points its pages at. Three things follow from that, each of
which is a silent failure if you skip it:

- **The entry URL expires.** It is a content hash over the whole client graph, so any file the entry
  reaches re-hashes it. Pages therefore reference a stable nifra URL that redirects to whichever chunk Bun
  is currently serving. Injecting a remembered URL is not a stale-cache annoyance: Bun answers a
  superseded chunk with a `location.reload()` stub, so the page reloads, gets the same dead URL from SSR,
  and loops forever - with every reload wiping the console that would have explained it.
- **Stylesheets have to be carried across.** Bun lifts `import "./app.css"` out of the JS graph and links
  it from the page it bundled, which is the throwaway. Without forwarding those links, the entire dev
  session renders unstyled while production, which reads CSS from the build manifest, is perfectly fine.
- **SSR freshness is ordered by request, not by clock.** Bun rebuilds and reloads the browser the instant
  a file is saved, which is faster than any file watcher can answer; SSR rendered from a watcher tick is
  still on the previous code when that reload lands, and React discards the server tree with a hydration
  mismatch. Rebuilding when Bun's entry hash moves - the same value already fetched to render the page -
  removes the race instead of shrinking it.

The client-leak guards still run. Bun's dev server does its own bundling, so the `buildClient` pass that
enforces them is no longer on the path that serves the app; it now runs beside the dev loop, off the hot
path, and reports. These stop server-only code and `node:` builtins reaching a browser, and a dev loop
that quietly stops enforcing them is how a leak reaches a deploy. Opt out with `guardLeaks: false`.

Reading Bun's output for the entry URL is isolated in one adapter with its own tests, including one that
runs a real Bun dev server and fails if the markup Bun emits ever changes shape - so a Bun upgrade breaks
a test rather than producing a dev server that boots cleanly and serves pages whose scripts 404.

Both pipelines now report a port collision the same way, since `Bun.serve` throws synchronously where
Node's http server emits an async `error` event.
