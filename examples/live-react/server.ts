/**
 * Live refresh demo on Bun: a poll whose page stays current in every open tab. The index loader
 * declares the key `votes`; the vote route publishes it once the tally changed, and every tab showing
 * the page reloads its counts and the query hook that names the same key.
 *
 *   bun run examples/live-react/build.ts     # build the client bundle first
 *   bun examples/live-react/server.ts        # then serve on http://localhost:3000
 */
import { t } from "@nifrajs/schema"
import { createWebApp } from "@nifrajs/web"
import type { BuildManifest } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { reactAdapter } from "@nifrajs/web-react"
import { liveRuntime } from "./backend/live"
import { lastVote, vote } from "./backend/votes"

const CHOICE = t.union([t.literal("bun"), t.literal("deno"), t.literal("node")])
const publicDir = `${import.meta.dir}/public`
// This example's own build output.
const assets: BuildManifest = JSON.parse(
  await Bun.file(`${publicDir}/assets/manifest.json`)
    .text()
    .catch(() => '{"entry":"/assets/missing.js","assets":[],"routes":{}}'),
)

const app = createWebApp({
  adapter: reactAdapter,
  manifest: discoverRoutes(`${import.meta.dir}/routes`),
  clientEntry: assets.entry,
  routePreload: assets.routes,
  title: "nifra - live refresh demo",
  live: liveRuntime,
})
  .get("/assets/*", async (c) => {
    const file = Bun.file(`${publicDir}${new URL(c.req.url).pathname}`)
    if (!(await file.exists())) return new Response("Not Found", { status: 404 })
    return new Response(file, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
      },
    })
  })
  .get("/api/last-vote", () => lastVote())
  .post("/api/vote", { body: t.object({ choice: CHOICE }) }, async (c) => {
    // Only this page votes.
    if (c.req.headers.get("origin") !== new URL(c.req.url).origin) {
      return new Response("Forbidden", { status: 403 })
    }
    vote(c.body.choice)
    // The write is readable now: every tab showing the poll reloads what read `votes`.
    await liveRuntime.publish("votes")
    return { ok: true }
  })

export type App = typeof app

if (import.meta.main) {
  const running = app.listen(Number(Bun.env.PORT ?? 3000))
  console.log(`http://localhost:${running.port}`)
}
