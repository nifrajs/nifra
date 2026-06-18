/** Server entry the ops benches spawn: the fixture app on Bun, PORT from env. With RSS_EVERY_MS
 * set, prints an `rss <bytes>` line on that interval (the soak bench parses these). */
import { app } from "./_app.ts"

const port = Number(Bun.env.PORT ?? 0)
const running = app.listen(port)
console.log(`ready ${running.port}`)

const every = Number(Bun.env.RSS_EVERY_MS ?? 0)
if (every > 0) {
  setInterval(() => {
    console.log(`rss ${process.memoryUsage().rss}`)
  }, every)
}
