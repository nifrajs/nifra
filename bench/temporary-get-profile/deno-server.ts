import { Session } from "node:inspector/promises"
import { serve } from "../../packages/deno/src/index.ts"
import { makeNifraApp as bare } from "../http/_nifra-app.ts"
import { makeWorstNifraApp } from "../http/worst-case/_app.ts"
import { makeNifraApp as realworld } from "../http-realworld/_nifra-app.ts"

const [shape, portText, output] = Deno.args
const port = Number(portText)
if (
  !Number.isSafeInteger(port) ||
  !output ||
  !["bare", "realworld", "generic"].includes(shape ?? "")
)
  throw new Error("expected shape, port and profile path")
const app =
  shape === "bare" ? bare() : shape === "realworld" ? realworld() : makeWorstNifraApp(true)
const inspector = new Session()
Deno.addSignalListener("SIGUSR1", () => {
  void (async () => {
    inspector.connect()
    await inspector.post("Profiler.enable")
    await inspector.post("Profiler.setSamplingInterval", { interval: 100 })
    await inspector.post("Profiler.start")
    await Deno.writeTextFile(`${output}.started`, "started")
  })()
})
Deno.addSignalListener("SIGUSR2", () => {
  void (async () => {
    const { profile } = await inspector.post("Profiler.stop")
    await Deno.writeTextFile(output, JSON.stringify(profile))
    inspector.disconnect()
  })()
})
const running = await serve(app, { port, hostname: "127.0.0.1" })
Deno.addSignalListener("SIGTERM", () => {
  void running.stop({ drainMs: 0 }).then(() => Deno.exit(0))
})
