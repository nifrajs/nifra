/**
 * Serves the fixture app on Deno's own server from a build `startPprAppOnDeno` made, then prints its
 * origin. Run by `server.ts`, never directly: `deno run --conditions=bun --config=deno.json`.
 */
import { readFileSync } from "node:fs"
import { reactAdapter } from "@nifrajs/web-react"
import { serve } from "../../../../../deno/src/index.ts"
import { countCancel, fixtureApp, type PreparedPprApp } from "./app.ts"

const preparedFile = process.argv[2]
if (preparedFile === undefined) throw new Error("deno-server.ts takes the prepared build's file")
const prepared: PreparedPprApp = JSON.parse(readFileSync(preparedFile, "utf8"))
const warnings: string[] = []
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "))
}
const app = fixtureApp(prepared, reactAdapter)
app.get("/__warnings", () => Response.json(warnings))
const running = await serve(
  {
    fetch: (request) => {
      countCancel(request)
      return app.fetch(request)
    },
  },
  { hostname: "127.0.0.1", port: 0 },
)
console.log(`http://127.0.0.1:${running.port}`)
