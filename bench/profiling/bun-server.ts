import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Diagnostic entry: graceful process exit lets Bun flush its CLI CPU/heap profiles after bounded load.
const target = process.argv[2]
const port = Number(process.argv[3])
if (!["nifra", "elysia"].includes(target ?? "") || !Number.isSafeInteger(port) || port < 1)
  throw new Error("usage: bun bun-server.ts <nifra|elysia> <port>")
if (target === "nifra") {
  const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice(11)
  const policy = process.argv.find((arg) => arg.startsWith("--policy="))?.slice(9) ?? "reject"
  if (policy !== "reject" && policy !== "strip" && policy !== "ignore")
    throw new Error("invalid prototype-poisoning policy")
  const { makeWorstNifraApp } = baseline
    ? await import(pathToFileURL(resolve(baseline)).href)
    : await import("../http/worst-case/_app.ts")
  makeWorstNifraApp(undefined, policy).listen(port)
} else {
  const { makeWorstElysiaApp } = await import("../http/worst-case/_elysia-app.ts")
  makeWorstElysiaApp().listen(port)
}
process.on("SIGTERM", () => process.exit(0))
process.on("SIGINT", () => process.exit(0))
