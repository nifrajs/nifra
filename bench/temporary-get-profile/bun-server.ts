import { makeNifraApp as bare } from "../http/_nifra-app.ts"
import { makeWorstNifraApp } from "../http/worst-case/_app.ts"
import { makeNifraApp as realworld } from "../http-realworld/_nifra-app.ts"

const [shape, portText] = process.argv.slice(2)
const port = Number(portText)
if (!Number.isSafeInteger(port) || !["bare", "realworld", "generic"].includes(shape ?? ""))
  throw new Error("expected shape and port")
const app =
  shape === "bare" ? bare() : shape === "realworld" ? realworld() : makeWorstNifraApp(true)
app.listen(port, { hostname: "127.0.0.1" })
process.on("SIGTERM", () => process.exit(0))
process.on("SIGINT", () => process.exit(0))
