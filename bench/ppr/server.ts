/** One bench server process for `cost.ts`: the bench app, `/__cpu` for its CPU time, `on <origin>` once listening. */
import { app } from "./app.ts"

app.get("/__cpu", () => Response.json(process.cpuUsage()))

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => app.fetch(request) })
console.log(`on http://127.0.0.1:${server.port}`)
