// TEMPORARY. Runs a Bun bench server module with the given argv and adds an exit port.
const [mod = "", ...args] = process.argv.slice(2)
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? args.at(-1))
process.argv = [process.argv[0] ?? "bun", mod, ...args]
await import(mod)
Bun.serve({
  port: port + 1,
  hostname: "127.0.0.1",
  fetch: (request) => {
    if (new URL(request.url).pathname === "/exit") setTimeout(() => process.exit(0), 5)
    return new Response("ok")
  },
})
console.log("ready")
