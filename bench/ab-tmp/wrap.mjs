// TEMPORARY. Runs a Node bench server module with the given argv and adds an exit port.
import { createServer } from "node:http"

const [mod, ...args] = process.argv.slice(2)
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? args.at(-1))
process.argv = [process.argv[0], mod, ...args]
await import(mod)
createServer((req, res) => {
  res.end("ok")
  if (req.url === "/exit") setTimeout(() => process.exit(0), 5)
}).listen(port + 1, "127.0.0.1", () => console.log("ready"))
