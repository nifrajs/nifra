/**
 * Auth demo — a nifra + React app with sessions. The protected page's loader reads the session
 * (`sessions.read`) and `requireUser` redirects to /login when absent; login/logout are plain nifra
 * routes (POST /api/login, /api/logout) — they have the full Context needed to WRITE the session
 * cookie, which a file-route action can't. CSRF guards the unsafe routes.
 *
 *   bun run examples/auth-react/build.ts
 *   bun examples/auth-react/server.ts        # http://localhost:3000
 */
import { csrf } from "@nifrajs/auth"
import { createWebApp, redirect } from "@nifrajs/web"
import type { BuildManifest } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import { reactAdapter } from "@nifrajs/web-react"
import { getSessions } from "./auth"

// One server-side session manager, injected into loaders as `api` (read in the loader via `ctx.api`,
// never imported into a route module — loaders aren't stripped from the client bundle, so a top-level
// server-only import there would ship `Bun.env`/the store to the browser).
const sessions = getSessions()

const publicDir = `${import.meta.dir}/public`
const assets = JSON.parse(
  await Bun.file(`${publicDir}/assets/manifest.json`)
    .text()
    .catch(() => '{"entry":"/assets/missing.js","assets":[],"routes":{}}'),
) as BuildManifest

const app = createWebApp({
  adapter: reactAdapter,
  manifest: discoverRoutes(`${import.meta.dir}/routes`),
  clientEntry: assets.entry,
  routePreload: assets.routes,
  api: sessions, // injected into every loader as `ctx.api` — the protected page reads it server-side
  title: "nifra — auth demo",
})

// CSRF: Origin check on all unsafe methods (login/logout). Same-origin in dev; set { origins } in prod.
app.use(csrf())

// Login: validate identity (here: any non-empty username — a real app verifies a password / OAuth),
// then set the session and redirect. `regenerate` rotates the id on login (session-fixation defense).
app.post("/api/login", async (c) => {
  const form = await c.req.formData()
  const username = String(form.get("username") ?? "").trim()
  if (username === "") return redirect("/login")
  const session = await sessions.get(c)
  session.set("userId", username)
  sessions.regenerate(session)
  await sessions.commit(c, session)
  return redirect("/")
})

// Logout: drop the server-side session + clear the cookie, then redirect to /login.
app.post("/api/logout", async (c) => {
  await sessions.destroy(c, await sessions.get(c))
  return redirect("/login")
})

app.get("/assets/*", async (c) => {
  const file = Bun.file(`${publicDir}${new URL(c.req.url).pathname}`)
  if (!(await file.exists())) return new Response("Not Found", { status: 404 })
  return new Response(file, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  })
})

if (import.meta.main) {
  const running = app.listen(Number(Bun.env.PORT ?? 3000))
  console.log(`http://localhost:${running.port}`)
}
