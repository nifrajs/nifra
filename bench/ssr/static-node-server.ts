import { serve } from "@nifrajs/node"
import { createStaticFetch } from "./static-node-handler.ts"

const dist = process.env.DIST
if (dist === undefined) throw new Error("set DIST to the built SSG output directory")
const port = Number(process.env.PORT ?? 4400)
await serve({ fetch: createStaticFetch(dist) }, { port, hostname: "127.0.0.1" })
