// Deno's memory capture control channel. Keep it separate from the Node inspector probe:
// Deno is supervised over a loopback HTTP endpoint instead of child-process IPC.
const port = Number(Deno.env.get("BENCH_CONTROL_PORT"))
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("BENCH_CONTROL_PORT must be a valid TCP port")
}
if (typeof globalThis.gc !== "function") {
  throw new Error("Deno memory capture needs --v8-flags=--expose-gc")
}

Deno.serve({ hostname: "127.0.0.1", port }, async (request) => {
  if (request.method !== "POST") return Response.json({ error: "POST required" }, { status: 405 })

  try {
    const { action } = await request.json()
    if (action !== "snapshot") throw new Error(`unsupported Deno probe action: ${action}`)
    globalThis.gc()
    await new Promise((resolve) => setTimeout(resolve, 0))
    globalThis.gc()
    return Response.json({
      result: {
        ...process.memoryUsage(),
        peakRss: process.resourceUsage().maxRSS * 1024,
      },
    })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
})

const target = Deno.env.get("BENCH_TARGET_URL")
if (target === null) throw new Error("BENCH_TARGET_URL is required")
await import(target)
