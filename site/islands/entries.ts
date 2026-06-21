/** Island enhancer bundle URLs — built by build-islands.ts, loaded via a route's `islandScripts`. */
export const HOME_COUNTER_ENTRY = "/assets/home-counter.client.js"
export const PLAYGROUND_ENTRY = "/assets/playground.client.js"
export const NIFRA_BOT_ENTRY = "/assets/nifra-bot.client.js"
export const FRAMEWORKS_ENTRY = "/assets/frameworks.client.js"

/** Starter snippet the /play route server-renders into the editor — matches the island's "hello"
 * preset so the SSR'd shell and the first client run agree. */
export const PLAYGROUND_STARTER_CODE = `// \`server\` and \`t\` are in scope. Build an app and \`return\` it.
const app = server()
  .get("/hello/:name", (c) => ({ hello: c.params.name }))
  .get("/add", { query: t.object({ a: t.string(), b: t.string() }) }, (c) => ({
    sum: Number(c.query.a) + Number(c.query.b),
  }))

return app`

export const PLAYGROUND_STARTER_REQUESTS = `[
  { "path": "/hello/world" },
  { "path": "/add?a=2&b=3" }
]`
