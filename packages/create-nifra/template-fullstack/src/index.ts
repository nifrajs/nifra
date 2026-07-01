import { app, queue } from "./app.ts"

// Start the in-process job worker (leases due jobs, runs them with retries/backoff). On Cloudflare
// Workers, drive a durable store from a CF Queues consumer with `queue.process()` instead — see the
// @nifrajs/jobs README.
queue.start()

const port = Number(process.env.PORT ?? 3000)
app.listen(port)
console.log(`▲ nifra full-stack app on http://localhost:${port}`)
