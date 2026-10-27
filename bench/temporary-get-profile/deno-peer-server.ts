import { makeNifraApp as bare } from "../http/_nifra-app.ts"
import { makeNifraApp as realworld } from "../http-realworld/_nifra-app.ts"

const [variant, shape, portText] = Deno.args
if (!["normal", "lazy"].includes(variant ?? "") || !["bare", "realworld"].includes(shape ?? ""))
  throw new Error("expected peer variant, shape and port")
const { serve } = await import(`./deno-peer-variants/${variant}/index.ts`)
const app = shape === "bare" ? bare() : realworld()
app.get("/__peer", (c) => ({ peer: c.clientIp }))
const running = await serve(app, { port: Number(portText), hostname: "127.0.0.1" })
Deno.addSignalListener("SIGTERM", () => {
  void running.stop({ drainMs: 0 }).then(() => Deno.exit(0))
})
