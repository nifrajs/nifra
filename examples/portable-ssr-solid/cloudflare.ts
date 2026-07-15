import { toFetchHandler } from "@nifrajs/core/server"
import { app } from "./app"

// Cloudflare Workers. Workers Assets (wrangler.toml `assets`) serves /assets/* from ./public; the
// worker SSRs everything else. `toFetchHandler` threads c.env / c.waitUntil from the platform.
export default toFetchHandler(app)
