/** One bench server process for `cost.ts`: the bench app, `/__cpu` for its CPU time, `on <origin>` once listening. */
import { app } from "./app.ts"

let rssStartBytes = process.memoryUsage.rss()
let sampledPeakRssBytes = rssStartBytes
const sampleRss = () => {
  sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage.rss())
}
const rssSampler = setInterval(sampleRss, 5)
rssSampler.unref()

app.get("/__metrics/reset", () => {
  rssStartBytes = process.memoryUsage.rss()
  sampledPeakRssBytes = rssStartBytes
  return Response.json({ ok: true })
})
app.get("/__cpu", () => {
  sampleRss()
  return Response.json({
    ...process.cpuUsage(),
    rssStartBytes,
    rssCurrentBytes: process.memoryUsage.rss(),
    sampledPeakRssBytes,
    sampledPeakRssDeltaBytes: Math.max(0, sampledPeakRssBytes - rssStartBytes),
  })
})

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => app.fetch(request) })
console.log(`on http://127.0.0.1:${server.port}`)
