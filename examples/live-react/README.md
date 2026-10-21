# live-react - pages that stay fresh on their own

A nifra + React poll. The index loader declares the live key `votes`; the vote route publishes it
after the tally changes, and every tab showing the page reloads its counts. A `useQuery` on the same
page names the same key, so it refetches too.

## Run it

```sh
bun run examples/live-react/build.ts     # build the client bundle (-> public/assets)
bun examples/live-react/server.ts        # serve on http://localhost:3000
```

Open the page in two tabs and vote in one: the other updates without a reload.

## How it works

- `backend/live.ts` creates the runtime with `live({ secret, subject, queryKeys: true })`, and
  `server.ts` passes it to `createWebApp({ live })`. The app now serves a WebSocket at
  `/_nifra/live` and a load endpoint at `/_nifra/live/load`.
- `build.ts` passes `live` to `buildClient`, so the client entry sends route loads through that
  endpoint. Each load returns an encrypted grant for the keys its loaders declared; the tab watches
  it over one socket.
- `routes/index.backend.ts` calls `live("votes")` in its loader. `POST /api/vote` changes the tally,
  then calls `liveRuntime.publish("votes")`. Every socket watching that key gets an opaque tag (no
  data, no key text) and reloads only the loaders that read it, through the same path a navigation
  takes.
- `useQuery(["last-vote"], fn, { live: ["votes"] })` in `routes/index.tsx` refetches on the same
  change. `queryKeys: true` lets the page match the key to the load's tags.

The tally lives in memory, so this demo runs as one process. Behind a load balancer, give every
process the same `redisLiveBus` from `@nifrajs/web/live-redis`; on Cloudflare Workers, use the
`liveHub()` Durable Object from `@nifrajs/web/live-hub`. See [the live refresh guide](https://nifra.dev/docs/live).
